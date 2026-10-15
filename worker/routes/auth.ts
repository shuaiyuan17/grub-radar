import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SigninResult } from '../../src/contracts/errors';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import { resolvePrincipal } from '../auth/principal';
import {
  clearSessionCookie,
  createSession,
  deleteSession,
  readSessionCookie,
  revokeSessionToken,
  setSessionCookie,
} from '../auth/session';
import {
  appleJwks,
  exchangeCode,
  nameFromUserField,
  readStateCookie,
  redirectUri,
  SiwaError,
  startAuthorize,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
  verifyIdToken,
} from '../auth/siwa';
import { ensureDevUser, signInWithApple } from '../db/users';
import { isDevelopment } from '../env';
import { sha256Hex } from '../lib/crypto';
import { apiError } from '../lib/http';

export const auth = new Hono<AppEnv>();

auth.get('/apple/start', async (c) => {
  // a same-site GET, so the Lax session cookie is here (unlike on the callback)
  const token = readSessionCookie(c);
  const prevSession = token && token.length <= 100 ? await sha256Hex(token) : undefined;
  const start = await startAuthorize(c.env, c.req.url, c.req.query('returnTo') ?? '/', prevSession);
  // SameSite=None: Apple's callback is a cross-site POST, which never carries Lax cookies.
  setCookie(c, STATE_COOKIE, start.cookie, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
    maxAge: STATE_MAX_AGE_S,
  });
  return c.redirect(start.url, 302);
});

const backTo = (c: Context<AppEnv>, result: SigninResult) => c.redirect(`/?signin=${result}`, 303);

auth.post('/callback', async (c) => {
  const form = await c.req.parseBody();
  const field = (name: string) => (typeof form[name] === 'string' ? form[name] : undefined);

  // State first, for every POST, errors included: anyone can make a browser
  // POST here, and only a matching state may touch the pending sign-in.
  const state = await readStateCookie(c.env, getCookie(c, STATE_COOKIE), field('state'));
  if (!state) {
    // leave the cookie alone: a forged POST must not cancel a real sign-in
    console.warn('sign in with apple failed', 'missing, forged, expired or mismatched state');
    return backTo(c, 'failed');
  }
  // single use from here on, whatever happens next
  deleteCookie(c, STATE_COOKIE, { path: '/', secure: true, sameSite: 'None' });

  const error = field('error');
  if (error) return backTo(c, error === 'user_cancelled_authorize' ? 'cancelled' : 'failed');

  try {
    const code = field('code');
    if (!code) throw new SiwaError('code', 'no authorization code');

    const tokens = await exchangeCode(c.env, code, redirectUri(c.env, c.req.url));
    const identity = await verifyIdToken(tokens.id_token, {
      clientId: c.env.APPLE_CLIENT_ID,
      nonceHash: state.nonceHash,
      keys: appleJwks(c.env),
    });
    const outcome = await signInWithApple(c.env, identity, {
      displayName: nameFromUserField(field('user')),
      refreshToken: tokens.refresh_token ?? null,
    });
    if (outcome.kind === 'closed') return backTo(c, 'closed');

    // the session this browser had when it set off to Apple (carried in the signed state)
    if (state.prevSession) await deleteSession(c.env.DB, state.prevSession);
    const { token } = await createSession(c.env.DB, outcome.userId, c.req.header('user-agent'));
    setSessionCookie(c, token);
    return c.redirect(state.returnTo, 303);
  } catch (e) {
    // reasons only: never the code, tokens or form body
    console.warn('sign in with apple failed', e instanceof SiwaError ? e.message : e);
    return backTo(c, 'failed');
  }
});

auth.post('/logout', resolvePrincipal, csrf, async (c) => {
  const p = c.var.principal;
  if (p.kind === 'user') await deleteSession(c.env.DB, p.sessionId);
  clearSessionCookie(c);
  return c.body(null, 204);
});

/**
 * Local-only shortcut for tests: a session for a fixed user (or one per `as` label) without Apple.
 * Exists only with ENVIRONMENT=development, on localhost, with DEV_LOGIN_SECRET set and sent.
 */
auth.post('/dev-login', resolvePrincipal, csrf, async (c) => {
  const secret = c.env.DEV_LOGIN_SECRET;
  const host = new URL(c.req.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1';
  if (!isDevelopment(c.env) || !secret || !local) return apiError(c, 404, 'not_found', 'not found');
  const sent = c.req.header('x-dev-login-secret') ?? '';
  const enc = new TextEncoder();
  const a = enc.encode(sent);
  const b = enc.encode(secret);
  if (a.byteLength !== b.byteLength || !crypto.subtle.timingSafeEqual(a, b))
    return apiError(c, 403, 'forbidden', 'wrong dev login secret');
  // optional { "as": "label" }: a separate dev user per label, so parallel e2e tests don't share a list
  const body: unknown = await c.req.json().catch(() => ({}));
  const label =
    body && typeof body === 'object' && 'as' in body && typeof body.as === 'string'
      ? body.as
      : undefined;
  if (label !== undefined && !/^[a-z0-9-]{1,40}$/.test(label))
    return apiError(c, 400, 'bad_request', 'as: lowercase letters, digits and dashes');
  const userId = await ensureDevUser(c.env.DB, label);
  await revokeSessionToken(c.env.DB, readSessionCookie(c));
  const { token } = await createSession(c.env.DB, userId, c.req.header('user-agent'));
  setSessionCookie(c, token);
  return c.body(null, 204);
});
