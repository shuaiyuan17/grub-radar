/**
 * grub radar Worker. Static assets (the SPA) are served by Cloudflare without
 * invoking this code; only the `run_worker_first` paths in wrangler.jsonc
 * land here.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './app';
import { principalResolver } from './auth/principal';
import { sweepSpentStates } from './db/authStates';
import { CorruptSpotError } from './db/spots';
import { apiError } from './lib/http';
import { timedD1 } from './lib/timedD1';
import { Timing } from './lib/timing';
import { agentDoor } from './agents/routes';
import { legal } from './legal/routes';
import { admin, noSuchEndpoint } from './routes/admin';
import { agentSettings } from './routes/agents';
import { auth } from './routes/auth';
import { friendPlacesPrefetch, friends, friendsPrefetch, invites } from './routes/friends';
import { mapkit } from './routes/mapkit';
import { me, mePrefetch } from './routes/me';
import { isPhotoUpload, photos, photosPrefetch } from './routes/photos';
import { places, placesSearchPrefetch } from './routes/places';
import { rollRoute, spots, spotsPrefetch } from './routes/spots';
import { VERSION } from './version';
import { publicOrigin } from './auth/siwa';
import { sweepPhotoDeletions } from './db/photos';
import type { Env } from './env';

const app = new Hono<AppEnv>();

const timed = (path: string) => path.startsWith('/api/') || path.startsWith('/auth/');

/**
 * Per request: a Timing, and a D1 binding that reports to it (a copy of env,
 * never the shared one). API and auth answers carry `Server-Timing` and log
 * one structured `request timing` line (phases, D1 round trips, rows, where
 * D1 ran). Deferred work is awaited here only when there's no ctx.waitUntil.
 */
app.use(async (c, next) => {
  const timing = new Timing();
  c.set('timing', timing);
  c.set('deferred', []);
  c.set('untimedDB', c.env.DB);
  c.env = { ...c.env, DB: timedD1(c.env.DB, timing) };
  await next();
  await Promise.all(c.var.deferred);
  const path = c.req.path;
  if (!timed(path)) return;
  c.res.headers.set('Server-Timing', timing.header());
  console.log(timing.record({ method: c.req.method, path, status: c.res.status }));
});

app.use(async (c, next) => {
  await next();
  // responses from env.ASSETS.fetch have immutable headers: copy before editing
  c.res = new Response(c.res.body, c.res);
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(self)');
  // JSON and redirects need nothing; static files keep the CSP from _headers
  if (!h.has('Content-Security-Policy'))
    h.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  // an API 401 tells an agent where to get a token (RFC 9728)
  if (c.res.status === 401 && c.req.path.startsWith('/api/') && !h.has('WWW-Authenticate'))
    h.set(
      'WWW-Authenticate',
      `Bearer resource_metadata="${publicOrigin(c.env, c.req.url)}/.well-known/oauth-protected-resource/api"`,
    );
  // API answers are never cached, unless the route says otherwise (a photo: private, long)
  if (timed(c.req.path) && !h.has('Cache-Control')) h.set('Cache-Control', 'no-store');
});

const smallBodies = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => apiError(c, 413, 'bad_request', 'request body too large'),
});
// a photo upload has its own limit (1 MB, in routes/photos.ts); everything else, 64 KB
app.use((c, next) => (isPhotoUpload(c.req) ? next() : smallBodies(c, next)));

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
app.route('/auth', auth);

// the reads these requests need ride along in the session lookup: one D1 round trip each
app.use(
  '/api/*',
  principalResolver((c) => {
    // an Apple search may need your home: read it with the session (GET or the app's POST)
    // the body (an add by `query`?) isn't read yet, so every add gets it: one row, same batch
    if (c.req.path === '/api/places/search') return placesSearchPrefetch(c.env);
    if (c.req.path === '/api/spots' && c.req.method === 'POST') return placesSearchPrefetch(c.env);
    if (c.req.path.startsWith('/api/photos')) return photosPrefetch(c, c.env);
    if (c.req.method !== 'GET') return null;
    if (c.req.path === '/api/me') return mePrefetch(c.env);
    if (c.req.path === '/api/spots') return spotsPrefetch(c.env);
    if (c.req.path === '/api/friends') return friendsPrefetch(c.env);
    if (c.req.path === '/api/friends/places') return friendPlacesPrefetch(c.env);
    return null;
  }),
);
app.route('/api/mapkit-token', mapkit);
app.route('/api/me', agentSettings);
app.route('/api/me', me);
app.route('/api/places', places);
app.route('/api/spots', spots);
app.route('/api/roll', rollRoute);
app.route('/api/friends', friends);
app.route('/api/invites', invites);
app.route('/api/photos', photos);
// owner-only; to everyone else, the same 404 as the line below
app.route('/api/admin', admin);

app.all('/api/*', noSuchEndpoint);
app.all('/auth/*', (c) => apiError(c, 404, 'not_found', 'no such endpoint'));
// the Privacy Policy and Terms of Service: public, plain HTML
app.route('/', legal);
// the agent door: OAuth, consent, MCP, and the docs agents read
app.route('/', agentDoor);
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? `${err.name}: ${err.message}` : err);
  if (err instanceof CorruptSpotError)
    return apiError(c, 500, 'internal', "one of your saved spots couldn't be read");
  return apiError(c, 500, 'internal', 'something broke');
});

/**
 * Cron (wrangler.jsonc triggers.crons, hourly): delete the photo bytes still
 * on the deletion outbox (anything a request's own sweep didn't finish, and
 * everything an account deletion cascaded), and the spent sign-in states that
 * can no longer be valid (auth_states_used).
 */
const scheduled: ExportedHandlerScheduledHandler<Env> = (_controller, env, ctx) => {
  ctx.waitUntil(
    sweepPhotoDeletions(env.DB, env.PHOTOS, { limit: 5000 }).then((r) => {
      if (r.deleted || r.failed) console.log('photo sweep', r);
    }),
  );
  ctx.waitUntil(
    sweepSpentStates(env.DB).then(
      (deleted) => {
        if (deleted) console.log('spent sign-in states swept', { deleted });
      },
      (e: unknown) => {
        console.error('state sweep failed', e instanceof Error ? e.message : e);
      },
    ),
  );
};

// the Hono app (fetch, and app.request for tests) plus the cron handler
export default Object.assign(app, { scheduled });
