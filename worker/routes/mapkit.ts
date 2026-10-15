import { Hono } from 'hono';
import type { AppEnv } from '../app';
import { isProduction } from '../env';
import { apiError } from '../lib/http';
import { createMapkitToken } from '../services/mapkitToken';

/**
 * GET /api/mapkit-token: public (the signed-out landing will draw a map),
 * rate-limited per IP. Body is the bare JWT, as mapkit.init's
 * authorizationCallback expects.
 */
export const mapkit = new Hono<AppEnv>();

mapkit.get('/', async (c) => {
  const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
  const { success } = await c.env.MAPKIT_TOKEN_LIMITER.limit({ key: `mapkit:${ip}` });
  if (!success) return apiError(c, 429, 'rate_limited', 'slow down');
  const origin = isProduction(c.env) ? c.env.PUBLIC_ORIGIN : new URL(c.req.url).origin;
  const token = await createMapkitToken(c.env, origin);
  return c.text(token, 200, { 'content-type': 'text/plain; charset=utf-8' });
});
