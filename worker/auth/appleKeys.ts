/**
 * Apple's id_token signing keys (JWKS), kept close so a sign-in doesn't pay
 * for a trip to appleid.apple.com/auth/keys every time:
 *
 *   1. this isolate's memory,
 *   2. the Cache API (shared by every isolate in the data center),
 *   3. Apple.
 *
 * How long: Apple's own Cache-Control max-age when it sends one (clamped to
 * 5 min .. 24 h). Today it sends `no-store`, which is about its HTTP caches,
 * not about how long a published public key stays valid, so then we keep the
 * set for an hour. Key rotation is covered by the refetch: a token whose `kid`
 * we don't have (or whose signature fails against a cached key) makes us ask
 * Apple again, at most once a minute per isolate, and verify once more.
 */
import { createLocalJWKSet, decodeProtectedHeader, type JSONWebKeySet } from 'jose';
import { z } from 'zod/mini';
import type { Env } from '../env';
import { MINUTE, HOUR } from '../lib/time';
import type { Timing } from '../lib/timing';
import { appleBase, SiwaError, verifyIdToken, type AppleIdentity } from './siwa';

export const JWKS_DEFAULT_TTL_MS = HOUR;
export const JWKS_MIN_TTL_MS = 5 * MINUTE;
export const JWKS_MAX_TTL_MS = 24 * HOUR;
/** A forced refetch (unknown kid) happens at most this often per isolate. */
export const JWKS_REFETCH_COOLDOWN_MS = MINUTE;
const FETCH_TIMEOUT_MS = 5000;

export type KeySource = 'memory' | 'cache' | 'network';

export interface AppleKeys {
  jwks: JSONWebKeySet;
  source: KeySource;
}

const Jwks = z.object({
  keys: z
    .array(z.looseObject({ kty: z.string(), kid: z.optional(z.string()) }))
    .check(z.minLength(1)),
});

interface Memo {
  jwks: JSONWebKeySet;
  expiresAt: number;
}
const memo = new Map<string, Memo>();
const lastForced = new Map<string, number>();

/** How long to keep a JWKS response, from its Cache-Control. */
export function jwksTtlMs(cacheControl: string | null): number {
  const maxAge = /(?:^|,)\s*max-age=(\d+)/i.exec(cacheControl ?? '')?.[1];
  if (maxAge === undefined) return JWKS_DEFAULT_TTL_MS;
  return Math.min(JWKS_MAX_TTL_MS, Math.max(JWKS_MIN_TTL_MS, Number(maxAge) * 1000));
}

const keysUrl = (env: Env) => `${appleBase(env)}/auth/keys`;

/** The Cache API, where the runtime has one (not in every test harness). */
function edgeCache(): Cache | null {
  try {
    return typeof caches === 'undefined' ? null : caches.default;
  } catch {
    return null;
  }
}

async function fromNetwork(url: string, now: number): Promise<Memo> {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new SiwaError('jwks', `Apple keys: http_${String(res.status)}`);
  const parsed = Jwks.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new SiwaError('jwks', 'Apple keys: unexpected response');
  const jwks = parsed.data as JSONWebKeySet;
  const ttl = jwksTtlMs(res.headers.get('cache-control'));
  const entry = { jwks, expiresAt: now + ttl };
  memo.set(url, entry);
  const cache = edgeCache();
  if (cache) {
    // our own headers: Apple says no-store, and the Cache API would obey that
    await cache
      .put(
        url,
        new Response(JSON.stringify(jwks), {
          headers: {
            'content-type': 'application/json',
            'cache-control': `max-age=${String(Math.round(ttl / 1000))}`,
            'x-grub-expires-at': String(entry.expiresAt),
          },
        }),
      )
      .catch(() => undefined);
  }
  return entry;
}

async function fromEdgeCache(url: string, now: number): Promise<Memo | null> {
  const cache = edgeCache();
  if (!cache) return null;
  const hit = await cache.match(url).catch(() => undefined);
  if (!hit) return null;
  const expiresAt = Number(hit.headers.get('x-grub-expires-at'));
  const parsed = Jwks.safeParse(await hit.json().catch(() => null));
  if (!parsed.success || !(expiresAt > now)) return null;
  const entry = { jwks: parsed.data as JSONWebKeySet, expiresAt };
  memo.set(url, entry);
  return entry;
}

/** Apple's key set, from the closest place that has a fresh copy. */
export async function appleKeys(env: Env, now = Date.now()): Promise<AppleKeys> {
  const url = keysUrl(env);
  const m = memo.get(url);
  if (m && m.expiresAt > now) return { jwks: m.jwks, source: 'memory' };
  const cached = await fromEdgeCache(url, now);
  if (cached) return { jwks: cached.jwks, source: 'cache' };
  return { jwks: (await fromNetwork(url, now)).jwks, source: 'network' };
}

/** Straight from Apple, bypassing both caches; null if we did that under a minute ago. */
async function forceRefresh(env: Env, now: number): Promise<AppleKeys | null> {
  const url = keysUrl(env);
  if (now - (lastForced.get(url) ?? -Infinity) < JWKS_REFETCH_COOLDOWN_MS) return null;
  lastForced.set(url, now);
  return { jwks: (await fromNetwork(url, now)).jwks, source: 'network' };
}

const hasKid = (jwks: JSONWebKeySet, kid: string | undefined) =>
  kid !== undefined && jwks.keys.some((k) => k.kid === kid);

/**
 * verifyIdToken against `keys` (the set appleKeys gave us). A token whose kid
 * isn't in a cached set, or that fails against it, gets one more try with a
 * fresh set from Apple (rotation). Everything verifyIdToken checks still applies.
 */
export async function verifyWithAppleKeys(
  env: Env,
  idToken: string,
  opts: { clientId: string; nonceHash: string },
  keys: AppleKeys,
  timing?: Timing,
  now = Date.now(),
): Promise<AppleIdentity> {
  const verify = (set: JSONWebKeySet) =>
    verifyIdToken(idToken, { ...opts, keys: createLocalJWKSet(set) });
  let kid: string | undefined;
  try {
    kid = decodeProtectedHeader(idToken).kid;
  } catch {
    // not a JWT: verify() says so
  }
  const retry = async () => {
    const fresh = await (timing
      ? timing.measure('jwks_refetch', () => forceRefresh(env, now))
      : forceRefresh(env, now));
    timing?.note('jwks_refetched', fresh !== null);
    return fresh;
  };
  if (keys.source !== 'network' && !hasKid(keys.jwks, kid)) {
    const fresh = await retry();
    return verify(fresh?.jwks ?? keys.jwks);
  }
  try {
    return await verify(keys.jwks);
  } catch (e) {
    // a cached key that no longer matches what Apple signs with
    if (!(e instanceof SiwaError) || e.reason !== 'id_token' || keys.source === 'network') throw e;
    const fresh = await retry();
    if (!fresh) throw e;
    return verify(fresh.jwks);
  }
}

/**
 * Tests: forget what this isolate holds, and (unless `isolateOnly`, which
 * simulates a fresh isolate in the same data center) the Cache API copy too.
 */
export async function resetAppleKeys(env: Env, opts: { isolateOnly?: boolean } = {}) {
  memo.clear();
  lastForced.clear();
  if (opts.isolateOnly) return;
  await edgeCache()
    ?.delete(keysUrl(env))
    .catch(() => undefined);
}
