/**
 * Apple Maps Server API: find restaurants, cafés and bakeries, and look a
 * place up by its Place ID. Used by the "add a spot" search (REST now, the
 * `search_places` / `add_spot` MCP tools later): one code path, one cache,
 * one quota (25,000 service calls a day for the whole app).
 *
 * Auth, per Apple's "Creating and using tokens with Maps Server API":
 * an ES256 JWT { iss: team, iat, exp, scope: "server_api" }, header
 * { kid, typ: JWT }, signed with APPLE_PRIVATE_KEY, is traded at
 * GET /v1/token for an access token (`expiresInSeconds`: 1800, seen live).
 * The access token is cached in this isolate and in the Cache API (shared by
 * every isolate in the data centre) until a minute before it expires.
 *
 * Search results are cached briefly (SEARCH_TTL_S) keyed by the normalized
 * query, the rounded centre and the language; place lookups for a day.
 * Cache API, not KV: free, no write quota, and these keys are near-unique.
 */
import { SignJWT } from 'jose';
import { z } from 'zod/mini';
import {
  ApplePlaceSchema,
  isPoiCategory,
  KIND_FOR_CATEGORY,
  normalizeQuery,
  POI_CATEGORIES,
  roundForSearch,
  SEARCH_MAX_RESULTS,
  type ApplePlace,
} from '../../src/contracts/places';
import { isLatLng, type LatLng } from '../../src/domain/geo';
import { ApplePlaceIdSchema, LIMITS, type DataLang } from '../../src/domain/spot';
import { signingKey } from '../auth/siwa';
import { isDevelopment, type Env } from '../env';

export const MAPS_API = 'https://maps-api.apple.com';
/** Not a real host: only ever a Cache API key, never fetched. */
const CACHE_HOST = 'https://apple-maps.cache.grub.internal';

export const SEARCH_TTL_S = 15 * 60;
export const PLACE_TTL_S = 24 * 60 * 60;
/** Stop using an access token this long before Apple says it expires. */
export const TOKEN_MARGIN_S = 60;
/** Lifetime of the signed JWT we trade for an access token (used once, right away). */
const AUTH_JWT_TTL_S = 300;
const TIMEOUT_MS = 5000;

/** Apple's `lang` for each language the app speaks. */
export const APPLE_LANG: Record<DataLang, string> = { en: 'en-US', 'zh-Hans': 'zh-CN' };

/** Apple Maps base URL. Only a development Worker may point it at a stub. */
export function mapsBase(env: Env): string {
  if (isDevelopment(env) && env.APPLE_MAPS_BASE) return env.APPLE_MAPS_BASE;
  return MAPS_API;
}

/**
 * Why Apple Maps couldn't help. `quota`: Apple said 429 (the app's daily
 * allowance is spent). `unavailable`: down, slow, misconfigured, or an answer
 * we couldn't read. `not_found`: no place with that id.
 */
export class AppleMapsError extends Error {
  readonly kind: 'unavailable' | 'quota' | 'not_found';
  constructor(kind: AppleMapsError['kind'], message: string) {
    super(message);
    this.name = 'AppleMapsError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// Apple's wire format: only the fields we read (Place, SearchResponse.Place)

const AppleLocation = z.object({ latitude: z.number(), longitude: z.number() });
const ApplePlaceWire = z.object({
  id: z.string(),
  name: z.string(),
  coordinate: AppleLocation,
  formattedAddressLines: z.optional(z.array(z.string())),
  country: z.optional(z.string()),
  poiCategory: z.optional(z.string()),
});
const SearchWire = z.object({ results: z.optional(z.array(z.unknown())) });
const TokenWire = z.object({ accessToken: z.string(), expiresInSeconds: z.number() });
const CachedToken = z.object({ accessToken: z.string(), expiresAt: z.number() });
const CachedPlaces = z.array(z.unknown());

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
/** At most `max` code points (never half a surrogate pair). */
const clamp = (s: string, max: number) => Array.from(s).slice(0, max).join('').trim();

/**
 * Apple's address lines as one line, without the country line:
 * ["2001 4th Ave", "Seattle, WA  98121", "United States"] -> "2001 4th Ave, Seattle, WA 98121".
 */
export function formatAddress(lines: readonly string[] | undefined, country?: string) {
  const parts = (lines ?? []).map(oneLine).filter(Boolean);
  if (parts.length > 1 && country && parts.at(-1) === oneLine(country)) parts.pop();
  const address = clamp(parts.join(', '), LIMITS.address);
  return address || undefined;
}

/** One Apple place as ours; null if it's missing something we need. */
export function toApplePlace(raw: unknown): ApplePlace | null {
  const parsed = ApplePlaceWire.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  const location = { lat: p.coordinate.latitude, lng: p.coordinate.longitude };
  const name = clamp(oneLine(p.name), LIMITS.name);
  if (!ApplePlaceIdSchema.safeParse(p.id).success || !isLatLng(location) || !name) return null;
  const address = formatAddress(p.formattedAddressLines, p.country);
  const category = isPoiCategory(p.poiCategory) ? p.poiCategory : undefined;
  return {
    applePlaceId: p.id,
    name,
    ...(address ? { address } : {}),
    location,
    ...(category ? { category, kind: KIND_FOR_CATEGORY[category] } : {}),
  };
}

// ---------------------------------------------------------------------------

export interface PlaceSearch {
  q: string;
  /** Centre of the search; rounded to ~1 km before it leaves the Worker. */
  near?: LatLng;
  lang: DataLang;
}

interface Deps {
  /** Defaults to caches.default. */
  cache?: Cache;
  now?: () => number;
  /** Lets cache writes finish after the response (ctx.waitUntil). */
  waitUntil?: (p: Promise<unknown>) => void;
}

// access tokens, per isolate: { base|kid -> token }, plus the one being fetched
const tokens = new Map<string, { accessToken: string; expiresAt: number }>();
const minting = new Map<string, Promise<string>>();

/** Tests: forget this isolate's access tokens. */
export function forgetAccessTokens() {
  tokens.clear();
  minting.clear();
}

export class AppleMaps {
  readonly #env: Env;
  readonly #base: string;
  readonly #cache: Cache;
  readonly #now: () => number;
  readonly #waitUntil: (p: Promise<unknown>) => void;

  constructor(env: Env, deps: Deps = {}) {
    this.#env = env;
    this.#base = mapsBase(env);
    this.#cache = deps.cache ?? caches.default;
    this.#now = deps.now ?? Date.now;
    this.#waitUntil =
      deps.waitUntil ??
      ((p) => {
        void p;
      });
  }

  /** Restaurants, cafés and bakeries matching `q`, best match first (at most 10). */
  async search(s: PlaceSearch): Promise<ApplePlace[]> {
    const q = normalizeQuery(s.q);
    const near = s.near ? roundForSearch(s.near) : undefined;
    const params = new URLSearchParams({
      q,
      includePoiCategories: POI_CATEGORIES.join(','),
      resultTypeFilter: 'Poi',
      lang: APPLE_LANG[s.lang],
    });
    // Apple: searchLocation and searchRegion can't both be sent (400). A point
    // is what we have; Apple ranks matches by distance from it.
    if (near) params.set('searchLocation', `${String(near.lat)},${String(near.lng)}`);
    const key = this.#cacheKey('search', {
      q,
      near: near ? `${String(near.lat)},${String(near.lng)}` : '',
      lang: s.lang,
    });
    const raw = await this.#cached(key, SEARCH_TTL_S, async () => {
      const body = SearchWire.safeParse(await this.#call('/v1/search', params));
      if (!body.success) throw new AppleMapsError('unavailable', 'unexpected search response');
      return (body.data.results ?? [])
        .map(toApplePlace)
        .filter((p): p is ApplePlace => p?.category !== undefined)
        .slice(0, SEARCH_MAX_RESULTS);
    });
    return raw.map(toCachedPlace).filter((p): p is ApplePlace => p !== null);
  }

  /** One place by its Apple Place ID. Apple doesn't say its category here. */
  async place(applePlaceId: string, lang: DataLang): Promise<ApplePlace> {
    const id = ApplePlaceIdSchema.safeParse(applePlaceId);
    if (!id.success) throw new AppleMapsError('not_found', 'not an Apple Maps place id');
    const key = this.#cacheKey('place', { id: id.data, lang });
    const [raw] = await this.#cached(key, PLACE_TTL_S, async () => {
      const place = toApplePlace(
        await this.#call(
          `/v1/place/${encodeURIComponent(id.data)}`,
          new URLSearchParams({ lang: APPLE_LANG[lang] }),
          { notFound: true },
        ),
      );
      if (!place) throw new AppleMapsError('unavailable', 'unexpected place response');
      return [place];
    });
    const place = toCachedPlace(raw);
    if (!place) throw new AppleMapsError('unavailable', 'unreadable cached place');
    return place;
  }

  /** A JSON GET against Apple with a valid access token; one retry with a fresh token on 401. */
  async #call(path: string, params: URLSearchParams, opts: { notFound?: boolean } = {}) {
    for (let attempt = 0; ; attempt++) {
      const token = await this.#accessToken(attempt > 0);
      const res = await this.#fetch(`${this.#base}${path}?${params.toString()}`, token);
      if (res.status === 401 && attempt === 0) continue; // revoked or expired early: mint anew
      if (opts.notFound && (res.status === 404 || res.status === 400))
        throw new AppleMapsError('not_found', 'no such place on Apple Maps');
      return this.#json(res, path);
    }
  }

  async #fetch(url: string, bearer: string): Promise<Response> {
    try {
      return await fetch(url, {
        headers: { authorization: `Bearer ${bearer}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw new AppleMapsError(
        'unavailable',
        `Apple Maps unreachable: ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }

  async #json(res: Response, what: string): Promise<unknown> {
    if (res.status === 429) throw new AppleMapsError('quota', 'Apple Maps daily quota reached');
    if (!res.ok) {
      // status only: Apple's error bodies are generic, and URLs carry the search
      console.error('apple maps', what, res.status);
      throw new AppleMapsError('unavailable', `Apple Maps answered ${String(res.status)}`);
    }
    try {
      return await res.json();
    } catch {
      throw new AppleMapsError('unavailable', 'Apple Maps sent something that is not JSON');
    }
  }

  // -------------------------------------------------------------------------
  // access token

  #tokenKey() {
    return `${this.#base}|${this.#env.APPLE_KEY_ID}`;
  }

  #tokenCacheKey() {
    return this.#cacheKey('token', { kid: this.#env.APPLE_KEY_ID });
  }

  /**
   * A Cache API key. Always carries the Apple base URL, so answers from a
   * stub (development) and from Apple never mix.
   */
  #cacheKey(kind: 'search' | 'place' | 'token', parts: Record<string, string>) {
    return `${CACHE_HOST}/${kind}?${new URLSearchParams({ base: this.#base, ...parts }).toString()}`;
  }

  /** A usable access token: this isolate's, the data centre's, or a fresh one. */
  async #accessToken(fresh: boolean): Promise<string> {
    const key = this.#tokenKey();
    const usable = (t: { expiresAt: number } | undefined) =>
      t !== undefined && t.expiresAt - TOKEN_MARGIN_S * 1000 > this.#now();
    if (fresh) {
      tokens.delete(key);
      await this.#cache.delete(this.#tokenCacheKey());
    } else {
      const memo = tokens.get(key);
      if (memo && usable(memo)) return memo.accessToken;
    }
    // one exchange at a time per isolate; concurrent searches share it
    let pending = fresh ? undefined : minting.get(key);
    if (!pending) {
      pending = (async () => {
        if (!fresh) {
          const hit = await this.#cache.match(this.#tokenCacheKey());
          const cached = hit ? CachedToken.safeParse(await hit.json().catch(() => null)) : null;
          if (cached?.success && usable(cached.data)) {
            tokens.set(key, cached.data);
            return cached.data.accessToken;
          }
        }
        const minted = await this.#mint();
        tokens.set(key, minted);
        const ttl = Math.floor((minted.expiresAt - this.#now()) / 1000) - TOKEN_MARGIN_S;
        if (ttl > 0) this.#put(this.#tokenCacheKey(), minted, ttl);
        return minted.accessToken;
      })().finally(() => minting.delete(key));
      minting.set(key, pending);
    }
    return pending;
  }

  /** GET /v1/token with our signed JWT -> { accessToken, expiresInSeconds }. */
  async #mint(): Promise<{ accessToken: string; expiresAt: number }> {
    const env = this.#env;
    let jwt: string;
    try {
      const iat = Math.floor(this.#now() / 1000);
      jwt = await new SignJWT({ scope: 'server_api' })
        .setProtectedHeader({ alg: 'ES256', kid: env.APPLE_KEY_ID, typ: 'JWT' })
        .setIssuer(env.APPLE_TEAM_ID)
        .setIssuedAt(iat)
        .setExpirationTime(iat + AUTH_JWT_TTL_S)
        .sign(await signingKey(env.APPLE_PRIVATE_KEY));
    } catch {
      console.error('apple maps: could not sign the token request (APPLE_PRIVATE_KEY?)');
      throw new AppleMapsError('unavailable', 'Apple Maps is not configured');
    }
    const res = await this.#fetch(`${this.#base}/v1/token`, jwt);
    const body = TokenWire.safeParse(await this.#json(res, '/v1/token'));
    if (!body.success) throw new AppleMapsError('unavailable', 'unexpected token response');
    return {
      accessToken: body.data.accessToken,
      expiresAt: this.#now() + body.data.expiresInSeconds * 1000,
    };
  }

  // -------------------------------------------------------------------------
  // Cache API

  async #cached(key: string, ttl: number, load: () => Promise<unknown[]>): Promise<unknown[]> {
    const hit = await this.#cache.match(key);
    if (hit) {
      const cached = CachedPlaces.safeParse(await hit.json().catch(() => null));
      if (cached.success) return cached.data;
    }
    const value = await load();
    this.#put(key, value, ttl);
    return value;
  }

  #put(key: string, value: unknown, ttl: number) {
    const res = new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json', 'cache-control': `max-age=${String(ttl)}` },
    });
    this.#waitUntil(
      this.#cache.put(key, res).catch((e: unknown) => {
        console.error('apple maps: cache put failed', e instanceof Error ? e.name : e);
      }),
    );
  }
}

/** A cached place, re-checked on the way out (the cache outlives deploys). */
function toCachedPlace(raw: unknown): ApplePlace | null {
  const place = ApplePlaceSchema.safeParse(raw);
  return place.success ? place.data : null;
}
