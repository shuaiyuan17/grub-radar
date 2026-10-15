/**
 * A stand-in for maps-api.apple.com, behind a fetch spy (the Worker runs in
 * the test's isolate). Like Apple, it only hands out an access token for an
 * ES256 JWT signed with our key, with scope "server_api", and only answers
 * searches carrying that token. Every place here is fictional.
 */
import { env } from 'cloudflare:workers';
import { importJWK, importPKCS8, exportJWK, jwtVerify, decodeProtectedHeader } from 'jose';
import { vi } from 'vitest';
import { normalizePem } from '../auth/siwa';
import { MAPS_API } from '../services/appleMaps';

export interface FakePlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  lines: string[];
  category?: string;
  /** Extra words a search matches on ("pho", "coffee"). */
  words?: string[];
}

/** Fictional places around a fictional downtown. */
export const FAKE_PLACES: FakePlace[] = [
  {
    id: 'IF0000000000000A1',
    name: 'Night Owl Pho',
    lat: 47.6152,
    lng: -122.3201,
    lines: ['101 Lantern St', 'Seattle, WA  98101', 'United States'],
    category: 'Restaurant',
    words: ['pho', 'noodles'],
  },
  {
    id: 'IF0000000000000A2',
    name: 'Pho Real',
    lat: 47.6101,
    lng: -122.3352,
    lines: ['22 Kettle Ave', 'Seattle, WA 98104', 'United States'],
    category: 'Restaurant',
    words: ['pho'],
  },
  {
    id: 'IF0000000000000B1',
    name: 'Paper Kite Coffee',
    lat: 47.6123,
    lng: -122.3311,
    lines: ['9 Kite Ln', 'Unit 2', 'Seattle, WA 98101', 'United States'],
    category: 'Cafe',
    words: ['coffee', 'espresso'],
  },
  {
    id: 'IF0000000000000C1',
    name: 'Little Ember Bakery',
    lat: 47.6188,
    lng: -122.3277,
    lines: ['300 Crumb Way', 'Seattle, WA 98102', 'United States'],
    category: 'Bakery',
    words: ['croissant', 'bakery'],
  },
  {
    // Apple filters by category itself; a stray one must still be dropped
    id: 'IF0000000000000D1',
    name: 'Pho Phill Gas',
    lat: 47.61,
    lng: -122.33,
    lines: ['1 Pump Rd', 'Seattle, WA 98101', 'United States'],
    category: 'GasStation',
    words: ['pho'],
  },
];

export interface FakeAppleMaps {
  /** Every request Apple saw, newest last. */
  requests: URL[];
  count(path: string): number;
  /** Answer the next calls to `path` (prefix) with this status instead. */
  failWith(path: string, status: number, times?: number): void;
  /** Make Apple reject every access token issued so far (as if they expired early). */
  revokeTokens(): void;
  restore(): void;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

const wire = (p: FakePlace, withCategory: boolean) => ({
  id: p.id,
  name: p.name,
  coordinate: { latitude: p.lat, longitude: p.lng },
  formattedAddressLines: p.lines,
  country: 'United States',
  countryCode: 'US',
  ...(withCategory && p.category ? { poiCategory: p.category } : {}),
});

/** The public half of APPLE_PRIVATE_KEY, to check our JWT like Apple does. */
async function publicKey() {
  const priv = await importPKCS8(normalizePem(env.APPLE_PRIVATE_KEY), 'ES256', {
    extractable: true,
  });
  const { kty, crv, x, y } = await exportJWK(priv);
  return importJWK({ kty, crv, x, y }, 'ES256');
}

export async function fakeAppleMaps(places: FakePlace[] = FAKE_PLACES): Promise<FakeAppleMaps> {
  const key = await publicKey();
  const realFetch = globalThis.fetch;
  const requests: URL[] = [];
  const failures: { path: string; status: number; left: number }[] = [];
  let valid = new Set<string>();
  let n = 0;

  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin !== MAPS_API) return realFetch(input, init);
    requests.push(url);
    const failure = failures.find((f) => url.pathname.startsWith(f.path) && f.left > 0);
    if (failure) {
      failure.left -= 1;
      return json({ error: { message: 'fake failure', details: [] } }, failure.status);
    }
    const bearer = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

    if (url.pathname === '/v1/token') {
      try {
        const header = decodeProtectedHeader(bearer);
        if (header.kid !== env.APPLE_KEY_ID || header.typ !== 'JWT') throw new Error('header');
        const { payload } = await jwtVerify(bearer, key, {
          issuer: env.APPLE_TEAM_ID,
          algorithms: ['ES256'],
          requiredClaims: ['iat', 'exp'],
        });
        if (payload.scope !== 'server_api') throw new Error('scope');
      } catch {
        return json({ error: { message: 'Not Authorized', details: [] } }, 401);
      }
      const token = `fake-access-${String(++n)}`;
      valid.add(token);
      return json({ accessToken: token, expiresInSeconds: 1800 });
    }

    if (!valid.has(bearer)) return json({ error: { message: 'Not Authorized', details: [] } }, 401);

    if (url.pathname === '/v1/search') {
      const p = url.searchParams;
      if (p.has('searchLocation') && p.has('searchRegion'))
        return json({ error: { message: 'Cannot specify both', details: [] } }, 400);
      const q = (p.get('q') ?? '').toLowerCase();
      const cats = p.get('includePoiCategories')?.split(',');
      const results = places
        .filter((pl) => [pl.name.toLowerCase(), ...(pl.words ?? [])].some((w) => w.includes(q)))
        .filter((pl) => !cats || pl.id === 'IF0000000000000D1' || cats.includes(pl.category ?? ''))
        .map((pl) => wire(pl, true));
      return json({ displayMapRegion: {}, results });
    }

    const placeId = /^\/v1\/place\/([^/]+)$/.exec(url.pathname)?.[1];
    if (placeId) {
      const pl = places.find((x) => x.id === decodeURIComponent(placeId));
      // like Apple: the place lookup carries no poiCategory
      return pl ? json(wire(pl, false)) : json({ error: { message: 'Not Found' } }, 404);
    }
    return json({ error: { message: 'no such endpoint' } }, 404);
  });

  return {
    requests,
    count: (path) => requests.filter((u) => u.pathname.startsWith(path)).length,
    failWith(path, status, times = Infinity) {
      failures.push({ path, status, left: times });
    },
    revokeTokens() {
      valid = new Set();
    },
    restore() {
      spy.mockRestore();
    },
  };
}
