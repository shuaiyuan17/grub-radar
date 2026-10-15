/**
 * grub radar Worker. Static assets (the SPA) are served by Cloudflare without
 * invoking this code; only the `run_worker_first` paths in wrangler.jsonc
 * land here.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AppEnv } from './app';
import { resolvePrincipal } from './auth/principal';
import { apiError } from './lib/http';
import { auth } from './routes/auth';
import { mapkit } from './routes/mapkit';
import { me } from './routes/me';
import { spots } from './routes/spots';
import { VERSION } from './version';

const app = new Hono<AppEnv>();

app.use(async (c, next) => {
  await next();
  const h = c.res.headers;
  h.set('X-Content-Type-Options', 'nosniff');
  h.set('X-Frame-Options', 'DENY');
  h.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  h.set('Permissions-Policy', 'geolocation=(self)');
  const path = c.req.path;
  if (path.startsWith('/api/') || path.startsWith('/auth/')) h.set('Cache-Control', 'no-store');
});

app.use(
  '*',
  bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) => apiError(c, 413, 'bad_request', 'request body too large'),
  }),
);

app.get('/api/health', (c) => c.json({ ok: true, version: VERSION }));
app.route('/api/mapkit-token', mapkit);
app.route('/auth', auth);

app.use('/api/*', resolvePrincipal);
app.route('/api/me', me);
app.route('/api/spots', spots);

app.all('/api/*', (c) => apiError(c, 404, 'not_found', 'no such endpoint'));
app.all('/auth/*', (c) => apiError(c, 404, 'not_found', 'no such endpoint'));
// the rest of run_worker_first (agent door, PR 5/6) isn't built yet: plain static handling
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  console.error('unhandled', err instanceof Error ? `${err.name}: ${err.message}` : err);
  return apiError(c, 500, 'internal', 'something broke');
});

export default app;
