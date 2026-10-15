import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SigninResult } from '../../src/contracts/errors';
import type { AppEnv } from '../app';
import { appleKeys, verifyWithAppleKeys } from '../auth/appleKeys';
import { csrf, csrfForCookie } from '../auth/csrf';
import { openPending, PENDING_COOKIE, PENDING_MAX_AGE_S, sealPending } from '../auth/pending';
import { resolvePrincipal } from '../auth/principal';
import {
  clearSessionCookie,
  createSession,
  newSession,
  readSessionCookie,
  revokeSessionToken,
  setSessionCookie,
} from '../auth/session';
import {
  exchangeCode,
  nameFromUserField,
  readStateCookie,
  redirectUri,
  SiwaError,
  startAuthorize,
  STATE_COOKIE,
  STATE_MAX_AGE_S,
} from '../auth/siwa';
import { localeFromAcceptLanguage, signingInCsp, signingInPage } from '../auth/signingInPage';
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

/**
 * A GET here is never Apple (it always POSTs): iOS/Safari preloading, or the
 * back button onto a finished sign-in. Nothing to do; send them to the app.
 * Query strings are ignored and never logged.
 */
auth.get('/callback', (c) => c.redirect('/', 303));

/**
 * Apple's form_post. Checks the state (exactly as before), then answers at
 * once with the "signing you in…" page; the slow part runs on /auth/finish.
 */
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
  const code = field('code');
  if (!code) {
    console.warn('sign in with apple failed', 'no authorization code');
    return backTo(c, 'failed');
  }

  const pending = await sealPending(c.env, state, { code, user: field('user') });
  setCookie(c, PENDING_COOKIE, pending.cookie, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: PENDING_MAX_AGE_S,
  });
  c.header('Content-Security-Policy', await signingInCsp());
  const locale = localeFromAcceptLanguage(c.req.header('accept-language'));
  return c.html(signingInPage(locale, pending.finish));
});

/**
 * Only POST finishes a sign-in (the page's form, with `t` in the body). A GET
 * here is a stale history entry or a preload: nothing to do, go home.
 */
auth.get('/finish', (c) => c.redirect('/', 303));

/**
 * The slow half of signing in, posted by the "signing you in…" page: needs
 * the sealed hand-off cookie AND the matching `t` in the body (never in the
 * URL, so never in history or logs). Then Apple's token exchange and its keys at the
 * same time, the id_token check (signature, iss, aud, exp, nonce), then one D1
 * batch that finds or creates the user and starts the session.
 */
auth.post('/finish', async (c) => {
  const timing = c.var.timing;
  // the form is on our own page: a browser that says otherwise isn't it
  const site = c.req.header('sec-fetch-site');
  const form = await c.req.parseBody();
  const sent = typeof form.t === 'string' ? form.t : undefined;
  const pending =
    site === undefined || site === 'same-origin'
      ? await openPending(c.env, getCookie(c, PENDING_COOKIE), sent)
      : null;
  if (!pending) {
    // like the state: a request without the matching `t` leaves the cookie alone
    console.warn('sign in with apple failed', 'missing, forged, expired or mismatched hand-off');
    return backTo(c, 'failed');
  }
  deleteCookie(c, PENDING_COOKIE, { path: '/', secure: true, sameSite: 'Lax' });

  try {
    const [tokens, keys] = await Promise.all([
      timing.measure('apple_token', () =>
        exchangeCode(c.env, pending.code, redirectUri(c.env, c.req.url)),
      ),
      timing.measure('jwks', () => appleKeys(c.env)),
    ]);
    timing.note('jwks_source', keys.source);
    const identity = await timing.measure('id_token_verify', () =>
      verifyWithAppleKeys(
        c.env,
        tokens.id_token,
        { clientId: c.env.APPLE_CLIENT_ID, nonceHash: pending.nonceHash },
        keys,
        timing,
      ),
    );
    const session = await newSession(c.req.header('user-agent'));
    const outcome = await timing.measure('signin_db', () =>
      signInWithApple(c.env, identity, {
        displayName: nameFromUserField(pending.user),
        refreshToken: tokens.refresh_token ?? null,
        session,
        // the session this browser had when it set off to Apple (carried in the signed state)
        ...(pending.prevSession ? { replaces: pending.prevSession } : {}),
      }),
    );
    timing.note('signin_outcome', outcome.kind);
    if (outcome.kind === 'closed') return backTo(c, 'closed');
    setSessionCookie(c, session.token);
    return c.redirect(pending.returnTo, 303);
  } catch (e) {
    // reasons only: never the code, tokens or form body
    console.warn('sign in with apple failed', e instanceof SiwaError ? e.message : e);
    return backTo(c, 'failed');
  }
});

/**
 * Ends this browser's session: one DELETE by the cookie's hash, no lookup
 * first (an already-dead session needs no proof). Same CSRF rules as any
 * cookie-authenticated write.
 */
auth.post('/logout', csrfForCookie, async (c) => {
  await revokeSessionToken(c.env.DB, readSessionCookie(c));
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
