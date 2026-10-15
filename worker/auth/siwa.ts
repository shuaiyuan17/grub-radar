/**
 * Sign in with Apple, web flow (response_type=code, response_mode=form_post).
 * See the design memo §3.1 for the sequence; every Apple fact used here is
 * from Apple's REST docs ("Generate and validate tokens", "Incorporating Sign
 * in with Apple into other platforms").
 */
import { importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod/mini';
import { clampName } from '../../src/contracts/me';
import { isDevelopment, type Env } from '../env';
import { openValue, randomToken, sealValue, sha256Hex } from '../lib/crypto';
import { MINUTE } from '../lib/time';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const STATE_COOKIE = '__Host-grub_siwa';
export const STATE_MAX_AGE_S = 600;
const CLIENT_SECRET_TTL_S = 300;

/** Apple's endpoints. Only a development Worker may point them at a stub. */
export function appleBase(env: Env): string {
  if (isDevelopment(env) && env.APPLE_ENDPOINT_BASE) return env.APPLE_ENDPOINT_BASE;
  return APPLE_ISSUER;
}

/** Our public origin: PUBLIC_ORIGIN, or in development whatever origin the request came in on. */
export function publicOrigin(env: Env, requestUrl: string): string {
  return isDevelopment(env) ? new URL(requestUrl).origin : env.PUBLIC_ORIGIN;
}

/** Where Apple sends the form POST: the registered return URL outside development. */
export function redirectUri(env: Env, requestUrl: string): string {
  return `${publicOrigin(env, requestUrl)}/auth/callback`;
}

/** Only same-origin paths: "/", "/place/x?y=1". Never "//evil.com" or "/\evil.com". */
export function safeReturnTo(raw: string | undefined | null): string {
  if (!raw || raw.length > 512) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/\p{Cc}/u.test(raw)) return '/';
  if (raw.startsWith('/auth/')) return '/';
  return raw;
}

// ---------------------------------------------------------------------------
// state: a sealed, self-authenticating `state` parameter (+ the same value in a cookie)
//
// The `state` we send Apple IS the payload, sealed with AES-GCM (key derived
// from SESSION_HMAC_KEY): { jti, nonceHash, returnTo, iat, prevSession? }.
// Encrypted, not just signed, because prevSession (the SHA-256 id of the
// browser's old session) has no business in Apple's logs or the URL bar.
// Apple echoes `state` back verbatim in its form_post, so the callback can
// verify it with no server-side storage and no cookie.
//
// The same sealed value also goes in the `__Host-grub_siwa` cookie
// (SameSite=None). When the browser sends that cookie back, it must equal the
// posted `state` exactly: that binds the callback to the browser that set off
// (path "cookie"). Some browsers don't send it on Apple's cross-site POST (an
// in-app browser handing off to another one, cross-site cookies blocked); then
// a valid, unexpired sealed state alone is accepted (path "signed-state-only").
//
// ACCEPTED TRADE-OFF: without the cookie, nothing ties the callback to the
// browser that started. Login CSRF becomes possible: an attacker who starts a
// sign-in in their own browser, signs in to Apple as themselves and makes a
// victim's browser POST their unused code + state here within 10 minutes can
// sign the victim in to the ATTACKER's account. Impact here is low (the
// victim sees the attacker's list; nothing of the victim's is exposed), and
// it's narrowed: such a sign-in never replaces a live session (/auth/finish
// sends an already-signed-in browser home untouched). A browser that does
// send the cookie still gets the binding: a mismatch is refused. A state that
// comes back with a code is single use either way (its jti in D1, see
// db/authStates.ts), and the id_token's nonce must still match nonceHash.

const STATE_SEAL_INFO = 'grub-radar siwa state v1';
/** Hard cap on what we try to open: our own states are well under 1 KB. */
const MAX_STATE_LENGTH = 2048;

/** The wire shape: short keys keep Apple's `state` parameter compact. */
const SealedState = z.strictObject({
  j: z.string().check(z.minLength(16)),
  n: z.string(),
  r: z.string(),
  t: z.number(),
  p: z.optional(z.string()),
});

export interface StatePayload {
  /** Random id: the state's single-use key in D1 (auth_states_used). */
  jti: string;
  /** SHA-256 (hex) of the nonce sent to Apple; the id_token must carry that nonce. */
  nonceHash: string;
  returnTo: string;
  /** When /auth/apple/start issued it (ms). */
  iat: number;
  /**
   * The session id (SHA-256 of the token) this browser had when it started
   * signing in. The callback can't see the Lax session cookie (Apple's POST
   * is cross-site), so it learns which session to end from here.
   */
  prevSession?: string;
}

/** Which proof the callback accepted: logged (the name only, never values). */
export type StatePath = 'cookie' | 'signed-state-only';

export interface AuthorizeStart {
  url: string;
  /** The sealed state: Apple's `state` parameter, and the state cookie's value. */
  state: string;
}

export async function startAuthorize(
  env: Env,
  requestUrl: string,
  returnTo: string,
  prevSession?: string,
  now = Date.now(),
): Promise<AuthorizeStart> {
  const nonce = randomToken(32);
  const sealed: z.infer<typeof SealedState> = {
    j: randomToken(16),
    n: await sha256Hex(nonce),
    r: safeReturnTo(returnTo),
    t: now,
    ...(prevSession ? { p: prevSession } : {}),
  };
  const state = await sealValue(JSON.stringify(sealed), env.SESSION_HMAC_KEY, STATE_SEAL_INFO);
  const url = new URL('/auth/authorize', appleBase(env));
  url.searchParams.set('client_id', env.APPLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(env, requestUrl));
  url.searchParams.set('response_type', 'code');
  // Apple: requesting any scope requires response_mode=form_post
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('scope', 'name email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return { url: url.toString(), state };
}

/** A sealed state we made, unexpired; else null. Says nothing about single use. */
export async function openState(
  env: Env,
  state: string | undefined,
  now = Date.now(),
): Promise<StatePayload | null> {
  if (!state || state.length > MAX_STATE_LENGTH) return null;
  const raw = await openValue(state, env.SESSION_HMAC_KEY, STATE_SEAL_INFO);
  if (raw === null) return null;
  let s: z.infer<typeof SealedState>;
  try {
    s = SealedState.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (now - s.t > STATE_MAX_AGE_S * 1000 || s.t > now + MINUTE) return null;
  return {
    jti: s.j,
    nonceHash: s.n,
    returnTo: safeReturnTo(s.r),
    iat: s.t,
    ...(s.p ? { prevSession: s.p } : {}),
  };
}

/**
 * The callback's state check (before single use, which needs D1):
 * - cookie sent: it must be exactly the posted state, and that state valid;
 * - no cookie: the posted state alone, if valid (see the trade-off above).
 * Null for missing / forged / expired / mismatched.
 */
export async function readState(
  env: Env,
  cookie: string | undefined,
  formState: string | undefined,
  now = Date.now(),
): Promise<{ payload: StatePayload; path: StatePath } | null> {
  if (!formState) return null;
  if (cookie !== undefined && !timingSafeEqualStrings(cookie, formState)) return null;
  const payload = await openState(env, formState, now);
  if (!payload) return null;
  return { payload, path: cookie !== undefined ? 'cookie' : 'signed-state-only' };
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// client secret + token exchange

/** Accepts real newlines or literal "\n" (how .dev.vars and some secret UIs carry PEMs). */
export const normalizePem = (pem: string) => pem.replaceAll('\\n', '\n').trim();

const signingKeys = new Map<string, Promise<CryptoKey>>();
/** The Apple ES256 key, imported once per isolate (SIWA client secrets and MapKit tokens). */
export function signingKey(pem: string): Promise<CryptoKey> {
  let key = signingKeys.get(pem);
  if (!key) {
    key = importPKCS8(normalizePem(pem), 'ES256');
    // don't cache a failed import forever
    key.catch(() => signingKeys.delete(pem));
    signingKeys.set(pem, key);
  }
  return key;
}

/**
 * The ES256 JWT Apple wants as client_secret. Minted fresh per exchange with
 * a 5 minute lifetime: no rotation state to keep.
 */
export async function createClientSecret(env: Env, now = Date.now()): Promise<string> {
  const iat = Math.floor(now / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID })
    .setIssuer(env.APPLE_TEAM_ID)
    .setSubject(env.APPLE_CLIENT_ID)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(iat)
    .setExpirationTime(iat + CLIENT_SECRET_TTL_S)
    .sign(await signingKey(env.APPLE_PRIVATE_KEY));
}

const TokenResponse = z.object({
  id_token: z.string(),
  refresh_token: z.optional(z.string()),
  access_token: z.optional(z.string()),
});
export type TokenResponse = z.infer<typeof TokenResponse>;

export class SiwaError extends Error {
  readonly reason: string;
  /** Apple's own error code, when Apple sent one (e.g. "invalid_grant"). */
  readonly appleError: string | undefined;
  constructor(reason: string, message?: string, appleError?: string) {
    super(message ?? reason);
    this.name = 'SiwaError';
    this.reason = reason;
    this.appleError = appleError;
  }
}

export async function exchangeCode(
  env: Env,
  code: string,
  redirect: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: env.APPLE_CLIENT_ID,
    client_secret: await createClientSecret(env),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirect,
  });
  const res = await fetch(`${appleBase(env)}/auth/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
  });
  const text = await res.text();
  if (!res.ok) {
    // Apple's errors are { error: "invalid_grant" | "invalid_client" | ... }; no secrets in there
    let error = `http_${res.status}`;
    try {
      const parsed: unknown = JSON.parse(text);
      if (
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        typeof parsed.error === 'string'
      )
        error = parsed.error;
    } catch {
      // not JSON
    }
    throw new SiwaError('token_exchange', `Apple token endpoint: ${error}`, error);
  }
  try {
    return TokenResponse.parse(JSON.parse(text));
  } catch {
    throw new SiwaError('token_exchange', 'Apple token endpoint: unexpected response');
  }
}

// ---------------------------------------------------------------------------
// id_token verification

const boolish = z.optional(
  z.union([
    z.boolean(),
    z.pipe(
      z.enum(['true', 'false']),
      z.transform((s) => s === 'true'),
    ),
  ]),
);
const IdTokenClaims = z.object({
  sub: z.string().check(z.minLength(1)),
  nonce: z.optional(z.string()),
  email: z.optional(z.string()),
  email_verified: boolish,
  is_private_email: boolish,
});

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailIsRelay: boolean;
}

/**
 * Verifies an Apple id_token: RS256 signature against Apple's keys, iss, aud,
 * exp (jose), then the nonce against the hash we kept in the sealed state.
 */
export async function verifyIdToken(
  idToken: string,
  opts: { clientId: string; nonceHash: string; keys: JWTVerifyGetKey },
): Promise<AppleIdentity> {
  let payload: unknown;
  try {
    ({ payload } = await jwtVerify(idToken, opts.keys, {
      issuer: APPLE_ISSUER,
      audience: opts.clientId,
      algorithms: ['RS256'],
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 60,
    }));
  } catch (e) {
    throw new SiwaError('id_token', `id_token rejected: ${e instanceof Error ? e.name : 'error'}`);
  }
  const claims = IdTokenClaims.safeParse(payload);
  if (!claims.success) throw new SiwaError('id_token', 'id_token claims malformed');
  const { sub, nonce, email, is_private_email } = claims.data;
  if (!nonce || (await sha256Hex(nonce)) !== opts.nonceHash)
    throw new SiwaError('nonce', 'id_token nonce mismatch');
  return {
    sub,
    email: email ?? null,
    emailIsRelay:
      is_private_email ?? email?.toLowerCase().endsWith('@privaterelay.appleid.com') ?? false,
  };
}

// ---------------------------------------------------------------------------
// the `user` form field (first authorization only)

const AppleUserField = z.object({
  name: z.optional(
    z.object({ firstName: z.optional(z.string()), lastName: z.optional(z.string()) }),
  ),
});

/** First name from Apple's one-time `user` JSON, if there is a usable one. */
export function nameFromUserField(raw: string | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = AppleUserField.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    const name = [parsed.data.name?.firstName, parsed.data.name?.lastName]
      .map((part) => part?.trim())
      .find((part) => part !== undefined && part !== '');
    if (name === undefined) return null;
    const clean = clampName(name);
    return clean === '' ? null : clean;
  } catch {
    return null;
  }
}
