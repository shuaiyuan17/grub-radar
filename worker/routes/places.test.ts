import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaceSearchResponseSchema } from '../../src/contracts/places';
import { SpotSchema } from '../../src/domain/spot';
import { forgetAccessTokens } from '../services/appleMaps';
import { fakeAppleMaps, type FakeAppleMaps } from '../test/appleMaps';
import { call, send, userSession } from '../test/helpers';

// fictional homes
const A_HOME = { lat: 47.618421, lng: -122.321937 };

const errorOf = async (res: Response) =>
  (await res.json<{ error: { code: string; message: string } }>()).error;
const spotOf = async (res: Response) => SpotSchema.parse(await res.json());
const count = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .first<{ n: number }>()
  )?.n;

let apple: FakeAppleMaps;
beforeEach(async () => {
  forgetAccessTokens();
  apple = await fakeAppleMaps();
});
afterEach(() => {
  apple.restore();
  vi.restoreAllMocks();
});

describe('GET /api/places/search', () => {
  let cookie = '';
  beforeAll(async () => {
    cookie = await userSession('u_search', 'Sid');
  });

  it('needs you signed in', async () => {
    const res = await call('/api/places/search?q=pho');
    expect(res.status).toBe(401);
    expect(apple.requests).toHaveLength(0);
  });

  it('finds restaurants, cafés and bakeries on Apple Maps around a point', async () => {
    const res = await call('/api/places/search?q=pho&near=47.6062,-122.3321&lang=en', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = PlaceSearchResponseSchema.parse(await res.json());
    expect(body.places.map((p) => [p.name, p.kind])).toEqual([
      ['Night Owl Pho', 'food'],
      ['Pho Real', 'food'],
    ]);
    const search = apple.requests.find((u) => u.pathname === '/v1/search');
    expect(search?.searchParams.get('searchLocation')).toBe('47.61,-122.33');
  });

  it('near=home searches around your saved home, and never says where that is', async () => {
    const home = await userSession('u_search_home');
    expect((await send('PUT', '/api/me/home', home, A_HOME)).status).toBe(204);
    const res = await call('/api/places/search?q=coffee&near=home', { cookie: home });
    expect(res.status).toBe(200);
    const search = apple.requests.find((u) => u.pathname === '/v1/search');
    // rounded to ~1 km before it leaves the Worker
    expect(search?.searchParams.get('searchLocation')).toBe('47.62,-122.32');
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('47.618421');
    expect(text).not.toContain('47.62,');
  });

  it('with no near: around home if saved, else anywhere', async () => {
    await call('/api/places/search?q=croissant', { cookie });
    const search = apple.requests.find((u) => u.pathname === '/v1/search');
    expect(search?.searchParams.has('searchLocation')).toBe(false);
  });

  it('near=home without a saved home is no_home', async () => {
    const res = await call('/api/places/search?q=pho&near=home', { cookie });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('no_home');
  });

  it.each([
    ['', /^q is 2\.\.100/],
    ['?q=p', /^q is/],
    [`?q=${'x'.repeat(101)}`, /^q is/],
    ['?q=pho&near=up', /^near/],
    ['?q=pho&near=91,0', /^near/],
    ['?q=pho&lang=fr', /^lang/],
  ])('rejects %s', async (qs, message) => {
    const res = await call(`/api/places/search${qs}`, { cookie });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toMatch(message);
    expect(apple.count('/v1/search')).toBe(0);
  });

  it('is braked per user (SEARCH_LIMITER), before Apple is asked', async () => {
    const limit = vi.spyOn(env.SEARCH_LIMITER, 'limit').mockResolvedValue({ success: false });
    const res = await call('/api/places/search?q=pho', { cookie });
    expect(res.status).toBe(429);
    expect((await errorOf(res)).code).toBe('rate_limited');
    expect(limit).toHaveBeenCalledWith({ key: 'search:u_search' });
    expect(apple.requests).toHaveLength(0);
  });

  it('Apple out of quota or down: 503 maps_unavailable with Retry-After', async () => {
    apple.failWith('/v1/search', 429, 1);
    let res = await call('/api/places/search?q=quota', { cookie });
    expect(res.status).toBe(503);
    expect((await errorOf(res)).code).toBe('maps_unavailable');
    expect(res.headers.get('retry-after')).toBe('3600');
    apple.failWith('/v1/search', 502, 1);
    res = await call('/api/places/search?q=down', { cookie });
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('30');
  });
});

describe('GET /api/places/:applePlaceId', () => {
  it('looks a place up', async () => {
    const cookie = await userSession('u_lookup');
    const res = await call('/api/places/IF0000000000000C1', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: 'Little Ember Bakery' });
    expect((await call('/api/places/IF0000000000000ZZ', { cookie })).status).toBe(404);
    expect((await call('/api/places/bad%20id', { cookie })).status).toBe(400);
    expect((await call('/api/places/IF0000000000000C1')).status).toBe(401);
  });
});

describe('POST /api/spots with an Apple Maps place', () => {
  const NIGHT_OWL = 'IF0000000000000A1';

  it('adds it with Apple’s name, location and address (201)', async () => {
    const cookie = await userSession('u_apple');
    const res = await send('POST', '/api/spots', cookie, {
      applePlaceId: NIGHT_OWL,
      kind: 'food',
    });
    expect(res.status).toBe(201);
    const spot = await spotOf(res);
    expect(spot).toMatchObject({
      name: 'Night Owl Pho',
      kind: 'food',
      status: 'want',
      icon: 'bowl',
      applePlaceId: NIGHT_OWL,
      address: '101 Lantern St, Seattle, WA 98101',
      location: { lat: 47.6152, lng: -122.3201 },
    });
    expect(spot.id).toMatch(/^p-[0-9a-z]{26}$/);
    // and it's on your list, as it'll read back
    expect(await (await call('/api/spots', { cookie })).json()).toEqual([spot]);
  });

  it('adding it again opens your entry: 200, nothing written, Apple not asked', async () => {
    const cookie = await userSession('u_again');
    const first = await spotOf(
      await send('POST', '/api/spots', cookie, { applePlaceId: NIGHT_OWL }),
    );
    await send('PATCH', `/api/spots/${first.id}`, cookie, { note: 'the 1am bowl' });
    const calls = apple.requests.length;
    const again = await send('POST', '/api/spots', cookie, {
      applePlaceId: NIGHT_OWL,
      kind: 'coffee',
      status: 'been',
      rating: 3,
    });
    expect(again.status).toBe(200);
    expect(await spotOf(again)).toMatchObject({
      id: first.id,
      kind: 'food',
      status: 'want',
      note: 'the 1am bowl',
    });
    expect(apple.requests.length).toBe(calls);
    expect(await count('SELECT COUNT(*) AS n FROM visits WHERE user_id = ?', 'u_again')).toBe(0);
  });

  it('someone else adding the same place reuses the one places row (and Apple is not asked)', async () => {
    const a = await userSession('u_share_a');
    const b = await userSession('u_share_b');
    const PAPER_KITE = 'IF0000000000000B1';
    const spotA = await spotOf(
      await send('POST', '/api/spots', a, { applePlaceId: PAPER_KITE, kind: 'coffee' }),
    );
    const lookups = apple.count('/v1/place');
    const resB = await send('POST', '/api/spots', b, {
      applePlaceId: PAPER_KITE,
      kind: 'coffee',
      status: 'been',
      rating: 9,
      note: 'oat cortado',
    });
    expect(resB.status).toBe(201);
    const spotB = await spotOf(resB);
    expect(spotB.id).toBe(spotA.id);
    expect(spotB).toMatchObject({ status: 'been', rating: 9, note: 'oat cortado' });
    expect(apple.count('/v1/place')).toBe(lookups);
    expect(
      await count('SELECT COUNT(*) AS n FROM places WHERE apple_place_id = ?', PAPER_KITE),
    ).toBe(1);
    // each person's entry is their own
    expect(await spotOf(await call(`/api/spots/${spotA.id}`, { cookie: a }))).toMatchObject({
      status: 'want',
    });
    expect(await count('SELECT COUNT(*) AS n FROM visits WHERE user_id = ?', 'u_share_b')).toBe(1);
  });

  it('two adds of the same place at once end on one place and one entry', async () => {
    const cookie = await userSession('u_race');
    const body = { applePlaceId: 'IF0000000000000C1', kind: 'bakery', status: 'been' };
    const [r1, r2] = await Promise.all([
      send('POST', '/api/spots', cookie, body),
      send('POST', '/api/spots', cookie, body),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 201]);
    expect((await spotOf(r1)).id).toBe((await spotOf(r2)).id);
    expect(await count('SELECT COUNT(*) AS n FROM user_places WHERE user_id = ?', 'u_race')).toBe(
      1,
    );
    expect(await count('SELECT COUNT(*) AS n FROM visits WHERE user_id = ?', 'u_race')).toBe(1);
  });

  it('never takes the place’s name or location from the request', async () => {
    const cookie = await userSession('u_spoof');
    const res = await send('POST', '/api/spots', cookie, {
      applePlaceId: NIGHT_OWL,
      name: 'Totally Different',
      location: { lat: 0, lng: 0 },
    });
    expect(res.status).toBe(400);
    expect(await count('SELECT COUNT(*) AS n FROM user_places WHERE user_id = ?', 'u_spoof')).toBe(
      0,
    );
  });

  it('its name and location are not yours to edit; your own fields are', async () => {
    const cookie = await userSession('u_edit');
    const spot = await spotOf(
      await send('POST', '/api/spots', cookie, { applePlaceId: 'IF0000000000000A2' }),
    );
    const rename = await send('PATCH', `/api/spots/${spot.id}`, cookie, { name: 'Mine Now' });
    expect(rename.status).toBe(403);
    expect((await errorOf(rename)).code).toBe('not_editable');
    const ok = await send('PATCH', `/api/spots/${spot.id}`, cookie, {
      kind: 'coffee',
      cuisine: 'pho',
    });
    expect(await spotOf(ok)).toMatchObject({
      kind: 'coffee',
      cuisine: 'pho',
      applePlaceId: 'IF0000000000000A2',
      address: '22 Kettle Ave, Seattle, WA 98104',
    });
  });

  it('removing it keeps the shared place row', async () => {
    const cookie = await userSession('u_remove');
    const spot = await spotOf(
      await send('POST', '/api/spots', cookie, { applePlaceId: 'IF0000000000000A2' }),
    );
    expect((await send('DELETE', `/api/spots/${spot.id}`, cookie)).status).toBe(204);
    expect(await count('SELECT COUNT(*) AS n FROM places WHERE id = ?', spot.id)).toBe(1);
    // and adding it back finds it without asking Apple
    const lookups = apple.count('/v1/place');
    expect(
      (await send('POST', '/api/spots', cookie, { applePlaceId: 'IF0000000000000A2' })).status,
    ).toBe(201);
    expect(apple.count('/v1/place')).toBe(lookups);
  });

  it('kind defaults to food when Apple’s lookup does not say', async () => {
    const cookie = await userSession('u_kind');
    const spot = await spotOf(
      await send('POST', '/api/spots', cookie, { applePlaceId: 'IF0000000000000C1' }),
    );
    expect(spot.kind).toBe('food');
  });

  it('an unknown Apple id is 404; Apple down is 503; nothing is written', async () => {
    const cookie = await userSession('u_fail');
    const missing = await send('POST', '/api/spots', cookie, {
      applePlaceId: 'IF0000000000000ZZ',
    });
    expect(missing.status).toBe(404);
    apple.failWith('/v1/place', 500);
    // a place nobody has saved yet, so Apple has to be asked
    const down = await send('POST', '/api/spots', cookie, { applePlaceId: 'IF0000000000000D1' });
    expect(down.status).toBe(503);
    expect((await errorOf(down)).code).toBe('maps_unavailable');
    expect(await count('SELECT COUNT(*) AS n FROM user_places WHERE user_id = ?', 'u_fail')).toBe(
      0,
    );
  });

  it('counts against the search brake too', async () => {
    const cookie = await userSession('u_brake');
    vi.spyOn(env.SEARCH_LIMITER, 'limit').mockResolvedValue({ success: false });
    const res = await send('POST', '/api/spots', cookie, { applePlaceId: NIGHT_OWL });
    expect(res.status).toBe(429);
    // adding by hand doesn't touch Apple, so it isn't braked by search
    const manual = await send('POST', '/api/spots', cookie, {
      name: 'Corner Stall',
      kind: 'food',
      location: { lat: 47.6, lng: -122.3 },
    });
    expect(manual.status).toBe(201);
  });

  it('needs the CSRF header like every write', async () => {
    const cookie = await userSession('u_csrf');
    const res = await call('/api/spots', {
      method: 'POST',
      cookie,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' },
      body: JSON.stringify({ applePlaceId: NIGHT_OWL }),
    });
    expect(res.status).toBe(403);
    expect(apple.requests).toHaveLength(0);
  });
});

describe('POST /api/spots with words (add_spot query)', () => {
  it('adds the best Apple match near you, kind from its category', async () => {
    const cookie = await userSession('u_query');
    const res = await send('POST', '/api/spots', cookie, {
      query: 'espresso',
      near: { lat: 47.6062, lng: -122.3321 },
      note: 'window seat',
    });
    expect(res.status).toBe(201);
    expect(await spotOf(res)).toMatchObject({
      name: 'Paper Kite Coffee',
      kind: 'coffee',
      icon: 'cup',
      note: 'window seat',
      applePlaceId: 'IF0000000000000B1',
    });
    // the search result is enough: no separate lookup
    expect(apple.count('/v1/place')).toBe(0);
  });

  it('nothing matches: 404 no_match', async () => {
    const cookie = await userSession('u_nomatch');
    const res = await send('POST', '/api/spots', cookie, { query: 'zzzz' });
    expect(res.status).toBe(404);
    expect((await errorOf(res)).code).toBe('no_match');
  });

  it('near=home without a home: no_home', async () => {
    const cookie = await userSession('u_qhome');
    const res = await send('POST', '/api/spots', cookie, { query: 'pho', near: 'home' });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('no_home');
  });

  it.each([
    [{ query: '' }, /^query/],
    [{ query: 'pho', rating: 8 }, /only rate places you have been to/],
    [{ query: 'pho', near: 'work' }, /^near/],
    [{ applePlaceId: 'not ok' }, /^applePlaceId/],
    [{ applePlaceId: 'I1', kind: 'bar' }, /^kind/],
  ])('rejects %j', async (body, message) => {
    const cookie = await userSession(`u_bad_${crypto.randomUUID().slice(0, 8)}`);
    const res = await send('POST', '/api/spots', cookie, body);
    expect(res.status).toBe(400);
    expect((await errorOf(res)).message).toMatch(message);
  });
});
