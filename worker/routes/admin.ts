/**
 * /api/admin/*: the owner-only admin page's API.
 *
 * To anyone who isn't an admin (signed out, an agent, any other person) every
 * path here, any method, is the exact 404 an unknown endpoint gets: nothing
 * says it exists. Admins are the Apple `sub`s in ADMIN_APPLE_SUBS (a secret).
 */
import { Hono, type Context } from 'hono';
import type { AppEnv } from '../app';
import { adminStats, isAdmin } from '../db/admin';
import { apiError } from '../lib/http';

/** Byte for byte what index.ts answers for an unknown /api path. */
export const noSuchEndpoint = (c: Context<AppEnv>) =>
  apiError(c, 404, 'not_found', 'no such endpoint');

export const admin = new Hono<AppEnv>();

admin.use(async (c, next) => {
  const p = c.var.principal;
  if (p.kind !== 'user' || !(await isAdmin(c.env.DB, c.env, p.userId))) return noSuchEndpoint(c);
  await next();
});

admin.get('/stats', async (c) => c.json(await adminStats(c.env.DB)));
