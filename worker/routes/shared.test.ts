import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { CreatedTokenSchema } from '../../src/contracts/agents';
import { SharedPlaceResponseSchema, sharedPlacePath } from '../../src/contracts/shared';
import { SpotSchema } from '../../src/domain/spot';
import { call, d1RoundTrips, send, userSession } from '../test/helpers';
import { webp } from '../test/images';

/**
 * A shared place (GET /api/places/:id/shared) and "add to my radar" (POST
 * /api/spots { placeId }). Ana shares spots; Ben is her friend; Cyd isn't.
 * Fictional people and places.
 */

const SECRET_MY_NOTE = 'SECRET-ana-mynote-4b1d';
const SECRET_WHY = 'SECRET-ana-why-0c9e';
const SECRET_DISH = 'SECRET-ana-dish-77aa';
const SECRET_TAG = 'secret-ana-tag';
const PRIVATE_NOTE = 'ana private one-liner';
const HOME = { lat: 47.123457, lng: -122.234567 };
const ORPHAN = 'p-orphan-nobody-has-it';
const APPLE_ORPHAN = 'p-apple-orphan';

const cookies: Record<string, string> = {};
let shared = '';
let hidden = '';

const get = (path: string, who: string) => call(path, { cookie: cookies[who] ?? '' });
const read = async (id: string, who: string) => {
  const res = await get(sharedPlacePath(id), who);
  expect(res.status).toBe(200);
  return SharedPlaceResponseSchema.parse(await res.json());
};

async function befriend(a: string, b: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO friendships VALUES (?, ?, 'x')").bind(`u_s_${a}`, `u_s_${b}`),
    env.DB.prepare("INSERT INTO friendships VALUES (?, ?, 'x')").bind(`u_s_${b}`, `u_s_${a}`),
  ]);
}

async function add(who: string, body: unknown) {
  const res = await send('POST', '/api/spots', cookies[who] ?? '', body);
  return { status: res.status, spot: SpotSchema.parse(await res.json()) };
}

beforeAll(async () => {
  for (const p of ['ana', 'ben', 'cyd']) cookies[p] = await userSession(`u_s_${p}`, p);
  const ana = cookies.ana ?? '';
  await befriend('ana', 'ben');

  // Ana: a spot she's been to, with everything that must stay hers
  const made = await add('ana', {
    name: 'Kite Noodle Bar',
    kind: 'food',
    location: { lat: 47.6101, lng: -122.3301 },
    status: 'been',
    verdict: 'good',
    note: 'get the cold noodles',
    why: SECRET_WHY,
    order: [SECRET_DISH],
    tags: [SECRET_TAG],
  });
  expect(made.status).toBe(201);
  shared = made.spot.id;
  expect(
    (await send('PATCH', `/api/spots/${shared}`, ana, { myNote: SECRET_MY_NOTE })).status,
  ).toBe(200);
  const photo = await call(`/api/photos?place=${shared}`, {
    method: 'POST',
    cookie: ana,
    headers: {
      'content-type': 'image/webp',
      'x-grub-request': '1',
      'sec-fetch-site': 'same-origin',
    },
    body: webp(),
  });
  expect(photo.status).toBe(201);

  // …and one just for her
  const priv = await add('ana', {
    name: 'Quiet Bakery',
    kind: 'bakery',
    location: { lat: 47.62, lng: -122.34 },
    note: PRIVATE_NOTE,
  });
  hidden = priv.spot.id;
  expect((await send('PATCH', `/api/spots/${hidden}`, ana, { visibility: 'private' })).status).toBe(
    200,
  );
  expect((await send('PUT', '/api/me/home', ana, HOME)).status).toBe(204);

  // places nobody has on a list (an Apple place outlives everyone removing it)
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO places (id, name, lat, lng, address, created_by, created_at, updated_at) VALUES (?, 'Lone Pho', 47.6, -122.3, '1 Fictional Way', 'u_s_ana', 'x', 'x')",
    ).bind(ORPHAN),
    env.DB.prepare(
      "INSERT INTO places (id, apple_place_id, name, lat, lng, address, created_at, updated_at) VALUES (?, 'IFAKESHARED01', 'Apple Pie Spot', 47.61, -122.31, '2 Fictional Way', 'x', 'x')",
    ).bind(APPLE_ORPHAN),
  ]);
});

describe('GET /api/places/:id/shared', () => {
  it("a friend sees the place and Ana's take: verdict, one-liner, kind, photos", async () => {
    const body = await read(shared, 'ben');
    expect(body.place).toEqual({
      id: shared,
      name: 'Kite Noodle Bar',
      location: { lat: 47.6101, lng: -122.3301 },
    });
    expect(body.friendsTakes).toHaveLength(1);
    const [take] = body.friendsTakes;
    expect(take).toMatchObject({
      friend: { id: 'u_s_ana', displayName: 'ana' },
      status: 'been',
      verdict: 'good',
      note: 'get the cold noodles',
      kind: 'food',
    });
    expect(take?.photos).toHaveLength(1);
    // and Ben may load that photo
    expect((await get(take?.photos[0]?.url ?? '', 'ben')).status).toBe(200);
  });

  it('never carries home, myNote, why, dishes, tags or who created it', async () => {
    const text = await (await get(sharedPlacePath(shared), 'ben')).text();
    for (const secret of [
      SECRET_MY_NOTE,
      SECRET_WHY,
      SECRET_DISH,
      SECRET_TAG,
      String(HOME.lat),
      String(HOME.lng),
      'myNote',
      'created_by',
      'createdBy',
      'visibility',
    ])
      expect(text).not.toContain(secret);
  });

  it('a non-friend gets the place only, exactly as for a place nobody has', async () => {
    const cyd = await read(shared, 'cyd');
    expect(cyd).toEqual({
      place: { id: shared, name: 'Kite Noodle Bar', location: { lat: 47.6101, lng: -122.3301 } },
      friendsTakes: [],
    });
    const text = await (await get(sharedPlacePath(shared), 'cyd')).text();
    for (const s of ['u_s_ana', 'cold noodles', SECRET_MY_NOTE, '/api/photos']) {
      expect(text).not.toContain(s);
    }
    // a place nobody has: the same shape, same keys; nothing tells them apart
    const orphan = await read(ORPHAN, 'cyd');
    expect(orphan.friendsTakes).toEqual([]);
    expect(Object.keys(orphan).sort()).toEqual(Object.keys(cyd).sort());
    expect(Object.keys(orphan.place).sort()).toEqual(['address', 'id', 'location', 'name']);
  });

  it('a private spot: the place, but not her take', async () => {
    const body = await read(hidden, 'ben');
    expect(body.place.name).toBe('Quiet Bakery');
    expect(body.friendsTakes).toEqual([]);
    expect(JSON.stringify(body)).not.toContain(PRIVATE_NOTE);
  });

  it('no such place, or not a place id: one and the same 404', async () => {
    const missing = await get(sharedPlacePath('p-nope'), 'ben');
    const junk = await get(sharedPlacePath('NOT_AN_ID'), 'ben');
    expect(missing.status).toBe(404);
    expect(junk.status).toBe(404);
    expect(await missing.text()).toBe(await junk.text());
  });

  it('signed out: 401 and nothing about the place', async () => {
    const res = await call(sharedPlacePath(shared));
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain('Kite');
    // a missing place reads the same signed out
    expect((await call(sharedPlacePath('p-nope'))).status).toBe(401);
  });

  it('an agent: 403, nothing about the place', async () => {
    const made = await send('POST', '/api/me/tokens', cookies.ben ?? '', {
      name: 'bot',
      scopes: ['spots:read', 'spots:write'],
    });
    const secret = CreatedTokenSchema.parse(await made.json()).secret;
    const res = await call(sharedPlacePath(shared), {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('Kite');
    // nor can it add one by place id
    const addRes = await call('/api/spots', {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ placeId: shared }),
    });
    expect(addRes.status).toBe(403);
  });

  it('rides along with the session: one D1 round trip', async () => {
    expect(d1RoundTrips(await get(sharedPlacePath(shared), 'ben'))).toBe(1);
  });
});

describe('POST /api/spots { placeId }: add to my radar', () => {
  it('adds the shared place as "want", with none of the sharer’s words; again: 200, one entry', async () => {
    const first = await add('cyd', { placeId: shared, status: 'want' });
    expect(first.status).toBe(201);
    expect(first.spot).toMatchObject({
      id: shared,
      name: 'Kite Noodle Bar',
      status: 'want',
      kind: 'food',
      location: { lat: 47.6101, lng: -122.3301 },
    });
    const spotText = JSON.stringify(first.spot);
    for (const s of ['cold noodles', SECRET_MY_NOTE, SECRET_WHY, SECRET_DISH, SECRET_TAG])
      expect(spotText).not.toContain(s);

    const again = await add('cyd', { placeId: shared, kind: 'coffee' });
    expect(again.status).toBe(200);
    expect(again.spot).toMatchObject({ id: shared, kind: 'food', version: 1 });
    const rows = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM user_places WHERE user_id = ? AND place_id = ?',
    )
      .bind('u_s_cyd', shared)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    // Ana's entry is untouched
    const anas = await get(`/api/spots/${shared}`, 'ana');
    expect(SpotSchema.parse(await anas.json())).toMatchObject({ note: 'get the cold noodles' });
  });

  it('an Apple place keeps its Apple id and address', async () => {
    const res = await add('ben', { placeId: APPLE_ORPHAN, kind: 'bakery' });
    expect(res.status).toBe(201);
    expect(res.spot).toMatchObject({
      applePlaceId: 'IFAKESHARED01',
      address: '2 Fictional Way',
      kind: 'bakery',
    });
  });

  it('no such place: 404, nothing written', async () => {
    const res = await send('POST', '/api/spots', cookies.ben ?? '', { placeId: 'p-nope' });
    expect(res.status).toBe(404);
    const rows = await env.DB.prepare('SELECT COUNT(*) AS n FROM user_places WHERE place_id = ?')
      .bind('p-nope')
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });

  it('the request can’t say what the place is', async () => {
    const res = await send('POST', '/api/spots', cookies.ben ?? '', {
      placeId: ORPHAN,
      name: 'Renamed',
    });
    expect(res.status).toBe(400);
  });
});
