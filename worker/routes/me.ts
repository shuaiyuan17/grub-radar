import { Hono } from 'hono';
import { PatchMeSchema, type MeResponse } from '../../src/contracts/me';
import { HomeSchema } from '../../src/contracts/spots';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import {
  limitWrites,
  prefetched,
  requireSession,
  sessionUser,
  type Prefetch,
} from '../auth/principal';
import { clearSessionCookie } from '../auth/session';
import {
  clearHome,
  getUser,
  meStatements,
  readMe,
  setHome,
  updateUser,
  userIdRef,
} from '../db/users';
import type { Env } from '../env';
import { apiError, readJson } from '../lib/http';

export const me = new Hono<AppEnv>();

me.use(requireSession);

const ME = 'GET /api/me';

/** GET /api/me's reads, run in the session lookup's batch (see index.ts). */
export const mePrefetch = (env: Env): Prefetch => ({
  key: ME,
  statements: (scope) => meStatements(env, env.DB, scope),
});

/**
 * Who you are: the profile came with the session row, home (and sign-up
 * state) with the same batch, so this is one D1 round trip in all.
 */
me.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const [user, results] = await Promise.all([
    c.var.account ?? getUser(c.env.DB, userId),
    prefetched(c, ME) ?? c.env.DB.batch(meStatements(c.env, c.env.DB, userIdRef(userId))),
  ]);
  if (!user) {
    clearSessionCookie(c);
    return apiError(c, 401, 'unauthorized', 'sign in first');
  }
  const { home, signupOpen } = readMe(c.env, results);
  const body: MeResponse = { user, home, signupOpen };
  return c.json(body);
});

me.patch('/', csrf, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const parsed = PatchMeSchema.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success)
    return apiError(c, 400, 'bad_request', parsed.error.issues[0]?.message ?? 'invalid body');
  const user = await updateUser(c.env.DB, userId, parsed.data);
  if (!user) return apiError(c, 401, 'unauthorized', 'sign in first');
  return c.json(user);
});

/**
 * Home: session only (agents never reach it), always in the body. Body is
 * `{ lat, lng }`; 204 either way, nothing echoed back.
 */
me.put('/home', csrf, limitWrites, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, HomeSchema);
  if (!body.ok) return body.res;
  await setHome(c.env.DB, userId, body.data);
  return c.body(null, 204);
});

me.delete('/home', csrf, limitWrites, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  await clearHome(c.env.DB, userId);
  return c.body(null, 204);
});
