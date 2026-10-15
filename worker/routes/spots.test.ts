import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { MeResponseSchema } from '../../src/contracts/me';
import { NearbyResponseSchema, RollResponseSchema } from '../../src/contracts/spots';
import { SEED_SPOTS } from '../../src/data/seed';
import { findNearby } from '../../src/domain/nearby';
import { parseSpots, SpotSchema, type Spot } from '../../src/domain/spot';
import app from '../index';
import { call, send, userSession, writeHeaders } from '../test/helpers';

// fictional homes, to prove they never leak outside GET /api/me
const A_HOME = { lat: 47.618421, lng: -122.321937 };
const B_HOME = { lat: 47.593317, lng: -122.297741 };

const NEW_SPOT = {
  name: 'Night Owl Pho',
  kind: 'food',
  location: { lat: 47.6152, lng: -122.3201 },
  cuisine: 'pho',
  price: '$',
  tags: ['noodles', 'late night'],
};

const errorOf = async (res: Response) =>
  (await res.json<{ error: { code: string; message: string } }>()).error;
const spotOf = async (res: Response) => SpotSchema.parse(await res.json());

describe('a brand-new user', () => {
  let cookie = '';
  beforeAll(async () => {
    cookie = await userSession('u_new', 'Nova');
  });

  it('starts with an empty list, not the demo', async () => {
    const res = await call('/api/spots', { cookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('has no home yet, so "nearby from home" asks for one', async () => {
    const res = await call('/api/spots/nearby?origin=home', { cookie });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('no_home');
  });
});

describe('writing your list over HTTP', () => {
  let cookie = '';
  let id = '';
  beforeAll(async () => {
    cookie = await userSession('u_w', 'Wren');
  });

  it('POST /api/spots adds a spot (201) that GET returns', async () => {
    const res = await send('POST', '/api/spots', cookie, NEW_SPOT);
    expect(res.status).toBe(201);
    const spot = await spotOf(res);
    id = spot.id;
    expect(spot).toMatchObject({ name: 'Night Owl Pho', status: 'want', price: '$' });
    expect(await (await call(`/api/spots/${id}`, { cookie })).json()).toEqual(spot);
    expect(await (await call('/api/spots', { cookie })).json()).toEqual([spot]);
  });

  it.each([
    [{ ...NEW_SPOT, name: '  ' }, /^name/],
    [{ ...NEW_SPOT, kind: 'bar' }, /^kind/],
    [{ ...NEW_SPOT, location: { lat: 91, lng: 0 } }, /^location\.lat/],
    [{ ...NEW_SPOT, verdict: 'good' }, /only give a verdict on places you have been to/],
    // the 1-10 score is gone: a number is not a verdict, and `rating` is not a field
    [{ ...NEW_SPOT, status: 'been', verdict: 8 }, /^verdict/],
    [{ ...NEW_SPOT, status: 'been', rating: 8 }, /Invalid input/],
    [{ ...NEW_SPOT, note: 'x'.repeat(61) }, /^note/],
    [{ ...NEW_SPOT, tags: Array.from({ length: 11 }, (_, i) => `t${i}`) }, /^tags/],
    [{ ...NEW_SPOT, id: 'lucky-thread' }, /id/],
    [{ name: 'only a name' }, /kind|location/],
  ])('rejects a bad add: %j', async (body, message) => {
    const res = await send('POST', '/api/spots', cookie, body);
    expect(res.status).toBe(400);
    const err = await errorOf(res);
    expect(err.code).toBe('bad_request');
    expect(err.message).toMatch(message);
  });

  it('rejects non-JSON and cross-site writes', async () => {
    const notJson = await call('/api/spots', {
      method: 'POST',
      cookie,
      headers: writeHeaders,
      body: 'name=x',
    });
    expect(notJson.status).toBe(400);
    const crossSite = await call('/api/spots', {
      method: 'POST',
      cookie,
      headers: { ...writeHeaders, 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify(NEW_SPOT),
    });
    expect(crossSite.status).toBe(403);
  });

  it('mark been with a verdict and a note, then change it', async () => {
    const res = await send('POST', `/api/spots/${id}/been`, cookie, {
      verdict: 'good',
      on: '2026-10-14',
      note: 'rare beef, extra basil',
    });
    expect(res.status).toBe(200);
    expect(await spotOf(res)).toMatchObject({
      status: 'been',
      verdict: 'good',
      myNote: '— 2026-10-14: rare beef, extra basil',
    });
    const again = await spotOf(await send('PATCH', `/api/spots/${id}`, cookie, { verdict: 'meh' }));
    expect(again.verdict).toBe('meh');
    // numbers (the old 1-10 score) and the old field are refused, everywhere
    for (const body of [{ verdict: 9 }, { verdict: 'great' }, { rating: 9 }]) {
      const bad = await send('POST', `/api/spots/${id}/been`, cookie, body);
      expect(bad.status).toBe(400);
      expect((await send('PATCH', `/api/spots/${id}`, cookie, body)).status).toBe(400);
    }
  });

  it('notes append, dated', async () => {
    const res = await send('POST', `/api/spots/${id}/notes`, cookie, {
      note: 'closed mondays',
      on: '2026-10-15',
    });
    expect((await spotOf(res)).myNote).toBe(
      '— 2026-10-14: rare beef, extra basil\n— 2026-10-15: closed mondays',
    );
    const empty = await send('POST', `/api/spots/${id}/notes`, cookie, { note: '  ' });
    expect(empty.status).toBe(400);
  });

  it('patch: order this, tags, the one-liner; back to want drops the verdict', async () => {
    const res = await send('PATCH', `/api/spots/${id}`, cookie, {
      order: [
        { dish: 'rare beef pho', tried: true },
        { dish: 'egg rolls', tried: false },
      ],
      tags: ['noodles'],
      note: 'the 1am bowl',
    });
    expect(await spotOf(res)).toMatchObject({
      order: [{ dish: 'rare beef pho', tried: true }, { dish: 'egg rolls' }],
      tags: ['noodles'],
      note: 'the 1am bowl',
    });
    const want = await spotOf(await send('PATCH', `/api/spots/${id}`, cookie, { status: 'want' }));
    expect(want.verdict).toBeUndefined();
    const rateWant = await send('PATCH', `/api/spots/${id}`, cookie, { verdict: 'bad' });
    expect(rateWant.status).toBe(400);
    expect((await errorOf(rateWant)).code).toBe('verdict_needs_been');
    for (const body of [{}, { id: 'x' }, { status: 'meh' }]) {
      expect((await send('PATCH', `/api/spots/${id}`, cookie, body)).status).toBe(400);
    }
  });

  it('delete: 204, then gone (404 for every verb)', async () => {
    expect((await send('DELETE', `/api/spots/${id}`, cookie)).status).toBe(204);
    expect((await call(`/api/spots/${id}`, { cookie })).status).toBe(404);
    expect((await send('DELETE', `/api/spots/${id}`, cookie)).status).toBe(404);
    expect((await send('POST', `/api/spots/${id}/been`, cookie, {})).status).toBe(404);
    expect(await (await call('/api/spots', { cookie })).json()).toEqual([]);
  });
});

describe('home, server-side', () => {
  let cookie = '';
  beforeAll(async () => {
    cookie = await userSession('u_h', 'Hana');
  });

  const me = async () => MeResponseSchema.parse(await (await call('/api/me', { cookie })).json());

  it('PUT saves it (body only), GET /api/me returns it, DELETE clears it', async () => {
    expect((await send('PUT', '/api/me/home', cookie, A_HOME)).status).toBe(204);
    expect((await me()).home).toEqual(A_HOME);
    expect((await send('PUT', '/api/me/home', cookie, B_HOME)).status).toBe(204);
    expect((await me()).home).toEqual(B_HOME);
    expect((await send('DELETE', '/api/me/home', cookie)).status).toBe(204);
    expect((await me()).home).toBeNull();
  });

  it.each([{}, { lat: 91, lng: 0 }, { lat: '47', lng: '-122' }, { lat: 1, lng: 2, extra: true }])(
    'rejects %j',
    async (body) => {
      expect((await send('PUT', '/api/me/home', cookie, body)).status).toBe(400);
    },
  );

  it('needs a session and the CSRF header', async () => {
    expect((await send('PUT', '/api/me/home', '', A_HOME)).status).toBe(401);
    const noHeader = await call('/api/me/home', {
      method: 'PUT',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(A_HOME),
    });
    expect(noHeader.status).toBe(403);
  });
});

describe('find_nearby and roll', () => {
  let cookie = '';
  let spots: Spot[] = [];
  beforeAll(async () => {
    cookie = await userSession('u_n', 'Nico');
    const res = await send('POST', '/api/spots/import-demo', cookie);
    expect(await res.json()).toEqual({ added: SEED_SPOTS.length });
    spots = parseSpots(await (await call('/api/spots', { cookie })).json());
    await send('PUT', '/api/me/home', cookie, A_HOME);
  });

  const nearby = async (qs: string) => {
    const res = await call(`/api/spots/nearby?${qs}`, { cookie });
    expect(res.status, qs).toBe(200);
    return NearbyResponseSchema.parse(await res.json()).spots;
  };

  it('matches the domain findNearby (same order, same minutes) from home', async () => {
    const got = await nearby('origin=home&maxMinutes=30&kinds=food,coffee&limit=50');
    const want = findNearby(spots, { origin: A_HOME, maxMinutes: 30, kinds: ['food', 'coffee'] });
    expect(got.map((s) => [s.id, s.minutes, s.mode, s.ring])).toEqual(
      want.map((v) => [v.spot.id, v.travel.minutes, v.travel.mode, v.ring]),
    );
    expect(got.length).toBeGreaterThan(0);
  });

  it('from home: no coordinates in the answer; from lat,lng: coordinates included', async () => {
    const fromHome = await nearby('origin=home&limit=50');
    expect(fromHome.every((s) => s.location === undefined)).toBe(true);
    const fromHere = await nearby('origin=47.61,-122.33');
    expect(fromHere.every((s) => s.location !== undefined)).toBe(true);
    expect(fromHere).toHaveLength(10); // default limit
  });

  it.each([
    'origin=nowhere',
    'origin=91,0',
    'maxMinutes=0',
    'maxMinutes=',
    'kinds=bars',
    'limit=0',
  ])('400 for %s', async (qs) => {
    expect((await call(`/api/spots/nearby?${qs}`, { cookie })).status).toBe(400);
  });

  it('roll picks one spot within reach, avoiding the previous pick', async () => {
    const inReach = findNearby(spots, { origin: A_HOME, maxMinutes: 30 }).map((v) => v.spot.id);
    const seen = new Set<string>();
    let previousId: string | undefined;
    for (let i = 0; i < 12; i++) {
      const res = await send('POST', '/api/roll', cookie, {
        origin: 'home',
        maxMinutes: 30,
        ...(previousId ? { previousId } : {}),
      });
      const { spot } = RollResponseSchema.parse(await res.json());
      expect(spot).not.toBeNull();
      expect(inReach).toContain(spot?.id);
      expect(spot?.id).not.toBe(previousId);
      expect(spot?.location).toBeUndefined();
      previousId = spot?.id;
      seen.add(spot?.id ?? '');
    }
    expect(seen.size).toBeGreaterThan(1);
  });

  it('roll with nothing in reach is null', async () => {
    const res = await send('POST', '/api/roll', cookie, {
      origin: { lat: -33.86, lng: 151.21 },
      maxMinutes: 10,
    });
    expect(await res.json()).toEqual({ spot: null });
  });

  it('home appears in no response but GET /api/me', async () => {
    const reads = [
      '/api/spots',
      '/api/spots/lucky-thread',
      '/api/spots/nearby?origin=home&limit=50',
      '/api/health',
    ];
    const bodies = await Promise.all(reads.map(async (p) => (await call(p, { cookie })).text()));
    bodies.push(await (await send('POST', '/api/roll', cookie, { origin: 'home' })).text());
    bodies.push(await (await send('POST', '/api/spots', cookie, NEW_SPOT)).text());
    bodies.push(await (await send('PUT', '/api/me/home', cookie, A_HOME)).text());
    for (const body of bodies) {
      expect(body).not.toContain(String(A_HOME.lat));
      expect(body).not.toContain(String(A_HOME.lng));
    }
  });
});

describe('import-demo is dev-only', () => {
  it('404s outside development', async () => {
    const cookie = await userSession('u_prod', 'Pat');
    const res = await app.request(
      'https://grub.shuaiyuan.me/api/spots/import-demo',
      { method: 'POST', headers: { ...writeHeaders, cookie }, body: '{}' },
      { ...env, ENVIRONMENT: 'production' },
    );
    expect(res.status).toBe(404);
    expect(await (await call('/api/spots', { cookie })).json()).toEqual([]);
  });
});

describe('user B can never read or write user A’s spots, notes, verdicts or home', () => {
  let a = '';
  let b = '';
  let aSpot: Spot;
  const A_NOTE = 'secret broth tip from A';

  beforeAll(async () => {
    a = await userSession('u_alice', 'Alice');
    b = await userSession('u_bob', 'Bob');
    await send('PUT', '/api/me/home', a, A_HOME);
    aSpot = await spotOf(await send('POST', '/api/spots', a, { ...NEW_SPOT, note: 'A only' }));
    await send('POST', `/api/spots/${aSpot.id}/been`, a, { verdict: 'good', note: A_NOTE });
    aSpot = await spotOf(await call(`/api/spots/${aSpot.id}`, { cookie: a }));
  });

  const aStillIntact = async () => {
    expect(await (await call(`/api/spots/${aSpot.id}`, { cookie: a })).json()).toEqual(aSpot);
    const me = MeResponseSchema.parse(await (await call('/api/me', { cookie: a })).json());
    expect(me.home).toEqual(A_HOME);
  };

  it("B's list, nearby and rolls never include A's spot", async () => {
    expect(await (await call('/api/spots', { cookie: b })).json()).toEqual([]);
    const near = await call('/api/spots/nearby?origin=47.61,-122.33', { cookie: b });
    expect(NearbyResponseSchema.parse(await near.json()).spots).toEqual([]);
    const rolled = await send('POST', '/api/roll', b, { origin: { lat: 47.61, lng: -122.33 } });
    expect(await rolled.json()).toEqual({ spot: null });
  });

  it("B gets a 404 for A's spot id, on every read and write", async () => {
    const path = `/api/spots/${aSpot.id}`;
    const attempts = [
      call(path, { cookie: b }),
      send('PATCH', path, b, { name: 'pwned', note: 'pwned' }),
      send('PATCH', path, b, { verdict: 'bad' }),
      send('POST', `${path}/been`, b, { verdict: 'bad', note: 'pwned' }),
      send('POST', `${path}/notes`, b, { note: 'pwned' }),
      send('DELETE', path, b),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(body).not.toContain(A_NOTE);
      expect(body).not.toContain('Night Owl');
    }
    await aStillIntact();
    // and no visit was recorded for B
    const visits = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM visits WHERE user_id = 'u_bob'",
    ).first<{ n: number }>();
    expect(visits?.n).toBe(0);
  });

  it("B can't reach A's home: not in /api/me, not as B's origin=home", async () => {
    const me = MeResponseSchema.parse(await (await call('/api/me', { cookie: b })).json());
    expect(me.home).toBeNull();
    const near = await call('/api/spots/nearby?origin=home', { cookie: b });
    expect((await errorOf(near)).code).toBe('no_home');
    // B setting and clearing B's home leaves A's alone
    await send('PUT', '/api/me/home', b, B_HOME);
    await send('DELETE', '/api/me/home', b);
    await aStillIntact();
  });

  it("B's own spots stay B's, and every B response is free of A's data", async () => {
    const bSpot = await spotOf(
      await send('POST', '/api/spots', b, { ...NEW_SPOT, note: 'B only' }),
    );
    expect(bSpot.id).not.toBe(aSpot.id);
    const aList = parseSpots(await (await call('/api/spots', { cookie: a })).json());
    expect(aList.map((s) => s.id)).toEqual([aSpot.id]);
    const bBodies = await Promise.all(
      ['/api/me', '/api/spots', `/api/spots/${bSpot.id}`, '/api/spots/nearby?origin=1,1'].map(
        async (p) => (await call(p, { cookie: b })).text(),
      ),
    );
    for (const body of bBodies) {
      expect(body).not.toContain(A_NOTE);
      expect(body).not.toContain('u_alice');
      expect(body).not.toContain(String(A_HOME.lat));
    }
    await aStillIntact();
  });

  it('a spot id in the body or query can’t redirect a write to someone else', async () => {
    const res = await send('POST', '/api/spots', b, { ...NEW_SPOT, userId: 'u_alice' });
    expect(res.status).toBe(400);
    const res2 = await send('PATCH', `/api/spots/${aSpot.id}?user=u_alice`, b, { note: 'x' });
    expect(res2.status).toBe(404);
    await aStillIntact();
  });
});

describe('signed out', () => {
  it.each([
    ['GET', '/api/spots/nearby?origin=home'],
    ['POST', '/api/spots'],
    ['PATCH', '/api/spots/x'],
    ['POST', '/api/spots/x/been'],
    ['POST', '/api/spots/x/notes'],
    ['DELETE', '/api/spots/x'],
    ['POST', '/api/roll'],
    ['PUT', '/api/me/home'],
    ['DELETE', '/api/me/home'],
    ['POST', '/api/spots/import-demo'],
  ])('%s %s is 401', async (method, path) => {
    const res = await call(path, {
      method,
      headers: writeHeaders,
      body: method === 'GET' ? undefined : JSON.stringify(NEW_SPOT),
    });
    expect(res.status).toBe(401);
  });
});

describe('CSRF on every write route (a valid session is not enough)', () => {
  let cookie = '';
  let id = '';
  beforeAll(async () => {
    cookie = await userSession('u_csrf', 'Cass');
    id = (await spotOf(await send('POST', '/api/spots', cookie, NEW_SPOT))).id;
  });

  // [method, label, path, body]
  const routes: [string, string, () => string, unknown][] = [
    ['POST', '/api/spots', () => '/api/spots', NEW_SPOT],
    ['PATCH', '/api/spots/:id', () => `/api/spots/${id}`, { note: 'pwned' }],
    ['POST', '/api/spots/:id/been', () => `/api/spots/${id}/been`, { verdict: 'bad' }],
    ['POST', '/api/spots/:id/notes', () => `/api/spots/${id}/notes`, { note: 'pwned' }],
    ['DELETE', '/api/spots/:id', () => `/api/spots/${id}`, {}],
    ['POST', '/api/roll', () => '/api/roll', { origin: { lat: 47.61, lng: -122.33 } }],
    ['POST', '/api/spots/import-demo', () => '/api/spots/import-demo', {}],
    ['PUT', '/api/me/home', () => '/api/me/home', A_HOME],
    ['DELETE', '/api/me/home', () => '/api/me/home', {}],
  ];

  it.each(routes.map(([method, label, path, body]) => ({ method, label, path, body })))(
    '$method $label from another site is 403 and changes nothing',
    async ({ method, path, body }) => {
      const before = await (await call(`/api/spots/${id}`, { cookie })).text();
      for (const headers of [
        { ...writeHeaders, 'sec-fetch-site': 'cross-site' },
        { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin' }, // no X-Grub-Request
      ]) {
        const res = await call(path(), { method, cookie, headers, body: JSON.stringify(body) });
        expect(res.status).toBe(403);
        expect((await errorOf(res)).code).toBe('csrf');
      }
      expect(await (await call(`/api/spots/${id}`, { cookie })).text()).toBe(before);
      expect(await (await call('/api/spots', { cookie })).json()).toHaveLength(1);
    },
  );
});

describe('versions, dates and brakes over HTTP', () => {
  it('PATCH with a stale version is a 409 and changes nothing', async () => {
    const cookie = await userSession('u_ver', 'Vera');
    const spot = await spotOf(await send('POST', '/api/spots', cookie, NEW_SPOT));
    const ok = await send('PATCH', `/api/spots/${spot.id}`, cookie, {
      tags: ['a'],
      version: spot.version,
    });
    expect((await spotOf(ok)).version).toBe(2);
    const stale = await send('PATCH', `/api/spots/${spot.id}`, cookie, {
      tags: ['b'],
      version: spot.version,
    });
    expect(stale.status).toBe(409);
    expect((await errorOf(stale)).code).toBe('conflict');
    expect((await spotOf(await call(`/api/spots/${spot.id}`, { cookie }))).tags).toEqual(['a']);
  });

  it('a future visit date is a 400', async () => {
    const cookie = await userSession('u_future', 'Fay');
    const spot = await spotOf(await send('POST', '/api/spots', cookie, NEW_SPOT));
    const res = await send('POST', `/api/spots/${spot.id}/been`, cookie, { on: '2099-01-01' });
    expect(res.status).toBe(400);
    expect((await errorOf(res)).code).toBe('future_date');
  });

  it('roll refuses an absurd previousId', async () => {
    const cookie = await userSession('u_prev', 'Pre');
    const res = await send('POST', '/api/roll', cookie, {
      origin: 'home',
      previousId: 'x'.repeat(101),
    });
    expect(res.status).toBe(400);
  });

  it('writes are braked per user (60/min), reads are not', async () => {
    const cookie = await userSession('u_spam', 'Sam');
    const other = await userSession('u_calm', 'Cal');
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++)
      statuses.push((await send('PUT', '/api/me/home', cookie, A_HOME)).status);
    expect(statuses.filter((s) => s === 204).length).toBeLessThanOrEqual(60);
    expect(statuses.at(-1)).toBe(429);
    expect((await send('POST', '/api/spots', cookie, NEW_SPOT)).status).toBe(429);
    expect((await call('/api/spots', { cookie })).status).toBe(200);
    expect((await send('POST', '/api/spots', other, NEW_SPOT)).status).toBe(201);
  });
});

describe('a corrupt saved spot', () => {
  it('fails the list loudly (500) instead of quietly hiding it', async () => {
    const cookie = await userSession('u_broken', 'Bro');
    const spot = await spotOf(await send('POST', '/api/spots', cookie, NEW_SPOT));
    await env.DB.prepare("UPDATE user_places SET order_json = '[{}]' WHERE place_id = ?")
      .bind(spot.id)
      .run();
    const res = await call('/api/spots', { cookie });
    expect(res.status).toBe(500);
    expect((await errorOf(res)).message).toMatch(/couldn't be read/);
    expect((await call(`/api/spots/${spot.id}`, { cookie })).status).toBe(500);
  });
});
