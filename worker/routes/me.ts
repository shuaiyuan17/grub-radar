import { Hono } from 'hono';
import { PatchMeSchema, type MeResponse } from '../../src/contracts/me';
import { HomeSchema } from '../../src/contracts/spots';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import { requireSession, sessionUser } from '../auth/principal';
import { clearSessionCookie } from '../auth/session';
import { clearHome, getHome, getUser, setHome, signupOpen, updateUser } from '../db/users';
import { apiError, readJson } from '../lib/http';

export const me = new Hono<AppEnv>();

me.use(requireSession);

me.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const [user, home, open] = await Promise.all([
    getUser(c.env.DB, userId),
    getHome(c.env.DB, userId),
    signupOpen(c.env),
  ]);
  if (!user) {
    clearSessionCookie(c);
    return apiError(c, 401, 'unauthorized', 'sign in first');
  }
  const body: MeResponse = { user, home, signupOpen: open };
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
me.put('/home', csrf, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, HomeSchema);
  if (!body.ok) return body.res;
  await setHome(c.env.DB, userId, body.data);
  return c.body(null, 204);
});

me.delete('/home', csrf, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  await clearHome(c.env.DB, userId);
  return c.body(null, 204);
});
