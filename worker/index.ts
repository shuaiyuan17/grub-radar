/**
 * grub radar Worker. Static assets (the SPA) are served by Cloudflare without
 * invoking this code; only the `run_worker_first` paths in wrangler.jsonc
 * land here.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './app';
import { principalResolver } from './auth/principal';
import { CorruptSpotError } from './db/spots';
import { apiError } from './lib/http';
import { timedD1 } from './lib/timedD1';
import { Timing } from './lib/timing';
import { admin, noSuchEndpoint } from './routes/admin';
import { auth } from './routes/auth';
import { friendPlacesPrefetch, friends, friendsPrefetch, invites } from './routes/friends';
import { mapkit } from './routes/mapkit';
import { me, mePrefetch } from './routes/me';
import { places, placesSearchPrefetch } from './routes/places';
import { rollRoute, spots, spotsPrefetch } from './routes/spots';
import { VERSION } from './version';

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
  if (timed(c.req.path)) h.set('Cache-Control', 'no-store');
});

app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => apiError(c, 413, 'bad_request', 'request body too large'),
  }),
);

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
    if (c.req.method !== 'GET') return null;
    if (c.req.path === '/api/me') return mePrefetch(c.env);
    if (c.req.path === '/api/spots') return spotsPrefetch(c.env);
    if (c.req.path === '/api/friends') return friendsPrefetch(c.env);
    if (c.req.path === '/api/friends/places') return friendPlacesPrefetch(c.env);
    return null;
  }),
);
app.route('/api/mapkit-token', mapkit);
app.route('/api/me', me);
app.route('/api/places', places);
app.route('/api/spots', spots);
app.route('/api/roll', rollRoute);
app.route('/api/friends', friends);
app.route('/api/invites', invites);
// owner-only; to everyone else, the same 404 as the line below
app.route('/api/admin', admin);

app.all('/api/*', noSuchEndpoint);
app.all('/auth/*', (c) => apiError(c, 404, 'not_found', 'no such endpoint'));
// the rest of run_worker_first (agent door, PR 5/6) isn't built yet: plain static handling
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? `${err.name}: ${err.message}` : err);
  if (err instanceof CorruptSpotError)
    return apiError(c, 500, 'internal', "one of your saved spots couldn't be read");
  return apiError(c, 500, 'internal', 'something broke');
});

export default app;
