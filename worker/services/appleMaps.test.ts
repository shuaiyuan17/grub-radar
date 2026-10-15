import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { fakeAppleMaps, type FakeAppleMaps } from '../test/appleMaps';
import {
  AppleMaps,
  AppleMapsError,
  forgetAccessTokens,
  formatAddress,
  mapsBase,
  MAPS_API,
  toApplePlace,
} from './appleMaps';

const DOWNTOWN = { lat: 47.60621, lng: -122.33207 };

let apple: FakeAppleMaps;
let cache: Cache;
let pending: Promise<unknown>[];
let clock: number;

/** A Worker-side client with its own cache (as if a fresh data centre) and a settable clock. */
function maps(c: Cache = cache) {
  return new AppleMaps(env, {
    cache: c,
    now: () => clock,
    waitUntil: (p) => pending.push(p),
  });
}
const settle = async () => {
  await Promise.all(pending);
  pending = [];
};

beforeEach(async () => {
  forgetAccessTokens();
  apple = await fakeAppleMaps();
  cache = await caches.open(`t-${crypto.randomUUID()}`);
  pending = [];
  clock = Date.now();
});
afterEach(() => {
  apple.restore();
});

describe('search', () => {
  it('asks Apple for restaurants, cafés and bakeries near a rounded point', async () => {
    const found = await maps().search({ q: '  PHO ', near: DOWNTOWN, lang: 'en' });
    const [token, search] = apple.requests;
    expect(token?.pathname).toBe('/v1/token');
    expect(search?.pathname).toBe('/v1/search');
    expect(Object.fromEntries(search?.searchParams ?? [])).toEqual({
      q: 'pho',
      includePoiCategories: 'Restaurant,Cafe,Bakery',
      resultTypeFilter: 'Poi',
      lang: 'en-US',
      // ~1 km: a precise point (your home) never goes to Apple
      searchLocation: '47.61,-122.33',
    });
    expect(search?.searchParams.has('searchRegion')).toBe(false);
    expect(found.map((p) => p.name)).toEqual(['Night Owl Pho', 'Pho Real']);
  });

  it('maps each result to our shape: one-line address without the country, kind from category', async () => {
    const [first] = await maps().search({ q: 'night owl', near: DOWNTOWN, lang: 'en' });
    expect(first).toEqual({
      applePlaceId: 'IF0000000000000A1',
      name: 'Night Owl Pho',
      address: '101 Lantern St, Seattle, WA 98101',
      location: { lat: 47.6152, lng: -122.3201 },
      category: 'Restaurant',
      kind: 'food',
    });
    const [cafe] = await maps().search({ q: 'espresso', lang: 'en' });
    expect(cafe).toMatchObject({ category: 'Cafe', kind: 'coffee' });
    const [bakery] = await maps().search({ q: 'croissant', lang: 'en' });
    expect(bakery).toMatchObject({ category: 'Bakery', kind: 'bakery' });
  });

  it('drops anything that is not a restaurant, café or bakery', async () => {
    const found = await maps().search({ q: 'pho', lang: 'en' });
    expect(found.map((p) => p.applePlaceId)).not.toContain('IF0000000000000D1');
  });

  it('without a centre, sends no location hint', async () => {
    await maps().search({ q: 'pho', lang: 'zh-Hans' });
    const search = apple.requests.find((u) => u.pathname === '/v1/search');
    expect(search?.searchParams.has('searchLocation')).toBe(false);
    expect(search?.searchParams.get('lang')).toBe('zh-CN');
  });

  it('caches results by normalized query + rounded centre + language', async () => {
    await maps().search({ q: 'pho', near: DOWNTOWN, lang: 'en' });
    await settle();
    // same words, other case/spacing, a few hundred metres away: the cached answer
    await maps().search({ q: 'Pho ', near: { lat: 47.6081, lng: -122.3349 }, lang: 'en' });
    expect(apple.count('/v1/search')).toBe(1);
    // another language or another neighbourhood: a new search
    await maps().search({ q: 'pho', near: DOWNTOWN, lang: 'zh-Hans' });
    await maps().search({ q: 'pho', near: { lat: 47.66, lng: -122.38 }, lang: 'en' });
    expect(apple.count('/v1/search')).toBe(3);
  });

  it('answers from a stub and from Apple never share a cache entry', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await settle();
    const stubbed = {
      ...env,
      ENVIRONMENT: 'development',
      APPLE_MAPS_BASE: 'http://127.0.0.1:9',
    } as Env;
    // nothing listens there: had the cache answered, this would resolve
    await expect(
      new AppleMaps(stubbed, { cache }).search({ q: 'pho', lang: 'en' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('a different data centre (another cache) searches again', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await settle();
    await maps(await caches.open('elsewhere')).search({ q: 'pho', lang: 'en' });
    expect(apple.count('/v1/search')).toBe(2);
  });
});

describe('the access token', () => {
  it('is minted once from an ES256 server_api JWT and reused while it lasts', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await maps().search({ q: 'coffee', lang: 'en' });
    await maps().place('IF0000000000000C1', 'en');
    expect(apple.count('/v1/token')).toBe(1);
  });

  it('is shared through the Cache API: a fresh isolate does not mint again', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await settle();
    forgetAccessTokens(); // a new isolate: nothing in memory
    await maps().search({ q: 'coffee', lang: 'en' });
    expect(apple.count('/v1/token')).toBe(1);
  });

  it('concurrent first searches share one exchange', async () => {
    await Promise.all([
      maps().search({ q: 'pho', lang: 'en' }),
      maps().search({ q: 'coffee', lang: 'en' }),
      maps().search({ q: 'croissant', lang: 'en' }),
    ]);
    expect(apple.count('/v1/token')).toBe(1);
  });

  it('is replaced a minute before Apple says it expires (1800 s)', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await settle();
    clock += (1800 - 61) * 1000;
    await maps().search({ q: 'coffee', lang: 'en' });
    expect(apple.count('/v1/token')).toBe(1);
    clock += 2000;
    forgetAccessTokens();
    await maps().search({ q: 'croissant', lang: 'en' });
    expect(apple.count('/v1/token')).toBe(2);
  });

  it('if Apple stops accepting it, a fresh one is minted and the call retried once', async () => {
    await maps().search({ q: 'pho', lang: 'en' });
    await settle();
    apple.revokeTokens();
    const found = await maps().search({ q: 'coffee', lang: 'en' });
    expect(found).toHaveLength(1);
    expect(apple.count('/v1/token')).toBe(2);
  });

  it('a token Apple refuses outright is "unavailable", not a crash', async () => {
    apple.failWith('/v1/token', 401);
    await expect(maps().search({ q: 'pho', lang: 'en' })).rejects.toMatchObject({
      kind: 'unavailable',
    });
  });

  it('a bad key is "unavailable" (and Apple is never called)', async () => {
    const broken = { ...env, APPLE_PRIVATE_KEY: 'not a key' } as Env;
    await expect(
      new AppleMaps(broken, { cache }).search({ q: 'pho', lang: 'en' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    expect(apple.requests).toHaveLength(0);
  });
});

describe('place lookup', () => {
  it('returns the place (Apple gives no category here)', async () => {
    const place = await maps().place('IF0000000000000B1', 'en');
    expect(place).toEqual({
      applePlaceId: 'IF0000000000000B1',
      name: 'Paper Kite Coffee',
      address: '9 Kite Ln, Unit 2, Seattle, WA 98101',
      location: { lat: 47.6123, lng: -122.3311 },
    });
  });

  it('is cached', async () => {
    await maps().place('IF0000000000000B1', 'en');
    await settle();
    await maps().place('IF0000000000000B1', 'en');
    expect(apple.count('/v1/place')).toBe(1);
  });

  it('an unknown id is not_found; a malformed one never reaches Apple', async () => {
    await expect(maps().place('IF0000000000000ZZ', 'en')).rejects.toMatchObject({
      kind: 'not_found',
    });
    await expect(maps().place('../token', 'en')).rejects.toMatchObject({ kind: 'not_found' });
    expect(apple.count('/v1/place')).toBe(1);
  });
});

describe('when Apple is unhappy', () => {
  it.each([
    [429, 'quota'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('%i -> %s', async (status, kind) => {
    apple.failWith('/v1/search', status);
    const err = await maps()
      .search({ q: 'pho', lang: 'en' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppleMapsError);
    expect(err).toMatchObject({ kind });
  });

  it('a failed search is not cached', async () => {
    apple.failWith('/v1/search', 500, 1);
    await expect(maps().search({ q: 'pho', lang: 'en' })).rejects.toThrow();
    await settle();
    expect(await maps().search({ q: 'pho', lang: 'en' })).toHaveLength(2);
  });
});

describe('pieces', () => {
  it('formatAddress: one line, single spaces, no country', () => {
    expect(formatAddress(['1 A St', 'Seattle, WA  98101', 'United States'], 'United States')).toBe(
      '1 A St, Seattle, WA 98101',
    );
    expect(formatAddress(['United States'], 'United States')).toBe('United States');
    expect(formatAddress([], 'United States')).toBeUndefined();
    expect(formatAddress(undefined)).toBeUndefined();
    expect(formatAddress(['x'.repeat(300)])).toHaveLength(200);
  });

  it('toApplePlace: skips results missing what we need', () => {
    const ok = {
      id: 'I1',
      name: 'A',
      coordinate: { latitude: 1, longitude: 2 },
      poiCategory: 'Cafe',
    };
    expect(toApplePlace(ok)).toMatchObject({ applePlaceId: 'I1', kind: 'coffee' });
    expect(toApplePlace({ ...ok, id: 'has space' })).toBeNull();
    expect(toApplePlace({ ...ok, name: '   ' })).toBeNull();
    expect(toApplePlace({ ...ok, coordinate: { latitude: 91, longitude: 0 } })).toBeNull();
    expect(toApplePlace({ ...ok, poiCategory: 'Zoo' })).not.toHaveProperty('kind');
    expect(toApplePlace(null)).toBeNull();
    // names are capped like any spot name
    expect(toApplePlace({ ...ok, name: 'n'.repeat(120) })?.name).toHaveLength(80);
  });

  it('mapsBase: the stub only in development', () => {
    const e = (ENVIRONMENT: string) =>
      ({ ...env, ENVIRONMENT, APPLE_MAPS_BASE: 'http://localhost:4599' }) as Env;
    expect(mapsBase(e('development'))).toBe('http://localhost:4599');
    expect(mapsBase(e('production'))).toBe(MAPS_API);
    expect(mapsBase(e('Development'))).toBe(MAPS_API);
  });
});
