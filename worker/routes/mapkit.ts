import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { requireSession, sessionUser } from '../auth/principal';
import { publicOrigin } from '../auth/siwa';
import { apiError } from '../lib/http';
import { createMapkitToken } from '../services/mapkitToken';

/**
 * GET /api/mapkit-token: a MapKit JS token for the browser. Signed-in only
 * until the signed-out map ships (then: public, with a tighter brake), and
 * rate-limited per user. Body is the bare JWT, as mapkit.init's
 * authorizationCallback expects.
 */
export const mapkit = new Hono<AppEnv>();

mapkit.use(requireSession);

mapkit.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const { success } = await c.env.MAPKIT_TOKEN_LIMITER.limit({ key: `mapkit:${userId}` });
  if (!success) return apiError(c, 429, 'rate_limited', 'slow down');
  const token = await createMapkitToken(c.env, publicOrigin(c.env, c.req.url));
  return c.text(token, 200, { 'content-type': 'text/plain; charset=utf-8' });
});
