/**
 * Sign in with Apple, web flow (response_type=code, response_mode=form_post).
 * See the design memo §3.1 for the sequence; every Apple fact used here is
 * from Apple's REST docs ("Generate and validate tokens", "Incorporating Sign
 * in with Apple into other platforms").
 */
import { createRemoteJWKSet, importPKCS8, jwtVerify, SignJWT, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod/mini';
import { clampName } from '../../src/contracts/me';
import { isDevelopment, type Env } from '../env';
import { randomToken, sha256Hex, signValue, verifyValue } from '../lib/crypto';
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
// state cookie: HMAC-signed { state, nonceHash, returnTo, iat }

const StatePayload = z.strictObject({
  state: z.string(),
  nonceHash: z.string(),
  returnTo: z.string(),
  iat: z.number(),
});
export type StatePayload = z.infer<typeof StatePayload>;

export interface AuthorizeStart {
  url: string;
  cookie: string;
}

export async function startAuthorize(
  env: Env,
  requestUrl: string,
  returnTo: string,
  now = Date.now(),
): Promise<AuthorizeStart> {
  const state = randomToken(32);
  const nonce = randomToken(32);
  const payload: StatePayload = {
    state,
    nonceHash: await sha256Hex(nonce),
    returnTo: safeReturnTo(returnTo),
    iat: now,
  };
  const url = new URL('/auth/authorize', appleBase(env));
  url.searchParams.set('client_id', env.APPLE_CLIENT_ID);
  url.searchParams.set('redirect_uri', redirectUri(env, requestUrl));
  url.searchParams.set('response_type', 'code');
  // Apple: requesting any scope requires response_mode=form_post
  url.searchParams.set('response_mode', 'form_post');
  url.searchParams.set('scope', 'name email');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  return {
    url: url.toString(),
    cookie: await signValue(JSON.stringify(payload), env.SESSION_HMAC_KEY),
  };
}

/** The verified state payload, or null if missing / forged / expired / not this state. */
export async function readStateCookie(
  env: Env,
  cookie: string | undefined,
  formState: string | undefined,
  now = Date.now(),
): Promise<StatePayload | null> {
  if (!cookie || !formState) return null;
  const raw = await verifyValue(cookie, env.SESSION_HMAC_KEY);
  if (raw === null) return null;
  let parsed: StatePayload;
  try {
    parsed = StatePayload.parse(JSON.parse(raw));
  } catch {
    return null;
  }
  if (now - parsed.iat > STATE_MAX_AGE_S * 1000 || parsed.iat > now + MINUTE) return null;
  if (!timingSafeEqualStrings(parsed.state, formState)) return null;
  return parsed;
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
  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'SiwaError';
    this.reason = reason;
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
    throw new SiwaError('token_exchange', `Apple token endpoint: ${error}`);
  }
  try {
    return TokenResponse.parse(JSON.parse(text));
  } catch {
    throw new SiwaError('token_exchange', 'Apple token endpoint: unexpected response');
  }
}

// ---------------------------------------------------------------------------
// id_token verification

const jwksCache = new Map<string, JWTVerifyGetKey>();
/** Apple's JWKS, cached per isolate; jose refetches on an unknown `kid`. */
export function appleJwks(env: Env): JWTVerifyGetKey {
  const url = `${appleBase(env)}/auth/keys`;
  let jwks = jwksCache.get(url);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(url), { timeoutDuration: 5000 });
    jwksCache.set(url, jwks);
  }
  return jwks;
}

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
 * exp (jose), then the nonce against the hash we kept in the state cookie.
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
