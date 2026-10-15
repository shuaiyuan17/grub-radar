/**
 * Test doubles for Apple: an RSA key pair standing in for Apple's JWKS, an
 * id_token minter, and a fetch mock for appleid.apple.com. The Worker runs in
 * the same isolate as the tests, so stubbing globalThis.fetch reaches it.
 */
import { env, exports } from 'cloudflare:workers';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import { vi } from 'vitest';
import { createSession } from '../auth/session';
import { APPLE_ISSUER } from '../auth/siwa';

export const ORIGIN = 'https://grub.test';
export const CLIENT_ID = 'me.shuaiyuan.grub.web';

export interface FakeApple {
  kid: string;
  jwks: { keys: JWK[] };
  idToken(claims?: JWTPayload, opts?: { kid?: string; alg?: string }): Promise<string>;
}

export async function fakeAppleKeys(kid = 'test-kid-1'): Promise<FakeApple> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return {
    kid,
    jwks: { keys: [jwk] },
    idToken(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      // defaults first, so a test can override any claim (iss, aud, exp, ...)
      return new SignJWT({
        iss: APPLE_ISSUER,
        aud: CLIENT_ID,
        sub: '000123.fictional-sub.0456',
        iat: now,
        exp: now + 600,
        email: 'tess@privaterelay.appleid.com',
        is_private_email: 'true',
        ...claims,
      })
        .setProtectedHeader({ alg: opts.alg ?? 'RS256', kid: opts.kid ?? kid })
        .sign(privateKey);
    },
  };
}

export interface TokenCall {
  form: URLSearchParams;
}

/**
 * Routes Apple traffic to fakes. `token` decides the /auth/token answer per
 * call; everything else falls through to the real fetch.
 */
export function mockApple(
  apple: FakeApple,
  token: (call: TokenCall) => Promise<Response> | Response,
) {
  const realFetch = globalThis.fetch;
  const calls: TokenCall[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    if (req.url === `${APPLE_ISSUER}/auth/keys`) return Response.json(apple.jwks);
    if (req.url === `${APPLE_ISSUER}/auth/token` && req.method === 'POST') {
      const call = { form: new URLSearchParams(await req.text()) };
      calls.push(call);
      return token(call);
    }
    return realFetch(input, init);
  });
  return { calls, spy };
}

/** A same-origin browser request to the Worker. */
export function call(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set('cookie', init.cookie);
  return exports.default.fetch(
    new Request(`${ORIGIN}${path}`, { ...init, headers, redirect: 'manual' }),
  );
}

/** Headers a same-origin fetch from the SPA sends with a write. */
export const writeHeaders = {
  'content-type': 'application/json',
  'x-grub-request': '1',
  'sec-fetch-site': 'same-origin',
};

/** name=value pairs from Set-Cookie, ready for a Cookie header. */
export function cookieFrom(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(';');
    if (pair?.startsWith(`${name}=`)) return pair;
  }
  return null;
}

export function setCookieLine(res: Response, name: string): string | undefined {
  return res.headers.getSetCookie().find((l) => l.startsWith(`${name}=`));
}

/** GET /auth/apple/start, returning what the browser would hold. */
export async function startSignIn(returnTo = '/', sessionCookie?: string) {
  // a same-site GET: the browser sends the Lax session cookie here, if it has one
  const res = await call(`/auth/apple/start?returnTo=${encodeURIComponent(returnTo)}`, {
    cookie: sessionCookie,
  });
  const location = new URL(res.headers.get('location') ?? 'about:blank');
  const cookie = cookieFrom(res, '__Host-grub_siwa');
  return {
    res,
    location,
    cookie: cookie ?? '',
    state: location.searchParams.get('state') ?? '',
    nonce: location.searchParams.get('nonce') ?? '',
  };
}

/** Apple's form_post back to us: a cross-site POST. */
export function postCallback(fields: Record<string, string>, cookie?: string) {
  return call('/auth/callback', {
    method: 'POST',
    cookie,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'cross-site',
      origin: 'https://appleid.apple.com',
    },
    body: new URLSearchParams(fields).toString(),
  });
}

/** A session for the fixed dev user, via POST /auth/dev-login. */
export async function devSession(): Promise<string> {
  const res = await exports.default.fetch(
    new Request('http://localhost/auth/dev-login', {
      method: 'POST',
      headers: { ...writeHeaders, 'x-dev-login-secret': env.DEV_LOGIN_SECRET ?? '' },
      body: '{}',
    }),
  );
  const cookie = cookieFrom(res, '__Host-grub_session');
  if (res.status !== 204 || !cookie) throw new Error(`dev login failed: ${res.status}`);
  return cookie;
}

export function tokenResponse(idToken: string, extra: Record<string, unknown> = {}) {
  return Response.json({
    access_token: 'at.fictional',
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: 'rt.fictional',
    id_token: idToken,
    ...extra,
  });
}

/** A fresh user with a session; returns the Cookie header value. */
export async function userSession(id: string, name = id): Promise<string> {
  await env.DB.prepare(
    "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, 'x', 'x')",
  )
    .bind(id, name)
    .run();
  const { token } = await createSession(env.DB, id, undefined);
  return `__Host-grub_session=${token}`;
}

/** A JSON write from the SPA (CSRF headers included). */
export function send(method: string, path: string, cookie: string, body?: unknown) {
  return call(path, {
    method,
    cookie,
    headers: writeHeaders,
    body: body === undefined ? '{}' : JSON.stringify(body),
  });
}
