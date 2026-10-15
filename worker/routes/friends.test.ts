import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  AcceptInviteResponseSchema,
  CreatedInviteSchema,
  FRIEND_LIMIT,
  FriendPlacesResponseSchema,
  FriendsResponseSchema,
  FriendSpotsResponseSchema,
  INVITES_PER_DAY,
  InvitePreviewSchema,
  InvitesResponseSchema,
} from '../../src/contracts/friends';
import { SEED_SPOTS } from '../../src/data/seed';
import { parseSpots } from '../../src/domain/spot';
import { call, d1RoundTrips, send, userSession, writeHeaders } from '../test/helpers';

/**
 * Friends, end to end through the Worker: who sees what (cross-user
 * isolation), and invite links (single use, expiry, revoke, own link,
 * accepting twice, two people racing for one link). Fictional people only.
 */

const [SHARED, PRIVATE, WANT] = parseSpots(SEED_SPOTS).map((s) => s.id) as [string, string, string];

// strings that must never reach anyone but Alice
const SECRET_MY_NOTE = 'SECRET-alice-mynote-7f3a';
const SECRET_WHY = 'SECRET-alice-why-91c2';
const PRIVATE_NOTE = 'alice private one-liner';
const HOME = { lat: 47.111111, lng: -122.222222 };

const cookies: Record<string, string> = {};
const people = ['alice', 'bob', 'carol'] as const;

const json = async <T = Record<string, unknown>>(res: Response) => res.json<T>();
const get = (path: string, who: string) => call(path, { cookie: cookies[who] });

async function invite(who: string): Promise<string> {
  const res = await send('POST', '/api/invites', cookies[who] ?? '');
  expect(res.status).toBe(201);
  return CreatedInviteSchema.parse(await res.json()).token;
}
const accept = (who: string, token: string) =>
  send('POST', '/api/invites/accept', cookies[who] ?? '', { token });

/** Everything `who` can learn about friends, as one string, for leak greps. */
async function everythingVisibleTo(who: string): Promise<string> {
  const bodies = await Promise.all(
    ['/api/friends', '/api/friends/places', '/api/friends/u_alice/spots'].map(async (p) =>
      (await get(p, who)).text(),
    ),
  );
  return bodies.join('\n');
}

beforeAll(async () => {
  for (const p of people) {
    cookies[p] = await userSession(`u_${p}`, p.charAt(0).toUpperCase() + p.slice(1));
    // everyone gets the fictional demo list: same place ids, so lists overlap
    expect((await send('POST', '/api/spots/import-demo', cookies[p] ?? '')).status).toBe(200);
  }
  const alice = cookies.alice ?? '';
  // Alice: been + verdict + a one-liner (shared), a private note and a why (never shared)
  expect(
    (
      await send('PATCH', `/api/spots/${SHARED}`, alice, {
        status: 'been',
        verdict: 'good',
        note: 'alice says hi',
        myNote: SECRET_MY_NOTE,
        why: SECRET_WHY,
      })
    ).status,
  ).toBe(200);
  // a private spot: friends never see it, nor its one-liner
  const priv = await send('PATCH', `/api/spots/${PRIVATE}`, alice, {
    visibility: 'private',
    note: PRIVATE_NOTE,
  });
  expect(priv.status).toBe(200);
  expect(await json(priv)).toMatchObject({ visibility: 'private' });
  expect((await send('PUT', '/api/me/home', alice, HOME)).status).toBe(204);
});

describe('visibility on your own spots', () => {
  it("defaults to friends (absent), can go private and back; it's in your list", async () => {
    const list = await json<{ id: string; visibility?: string }[]>(
      await get('/api/spots', 'alice'),
    );
    expect(list.find((s) => s.id === SHARED)).not.toHaveProperty('visibility');
    expect(list.find((s) => s.id === PRIVATE)).toMatchObject({ visibility: 'private' });
    const bad = await send('PATCH', `/api/spots/${WANT}`, cookies.alice ?? '', {
      visibility: 'public',
    });
    expect(bad.status).toBe(400);
  });
});

describe('a non-friend sees nothing', () => {
  it('before any invite: no friends, no takes, no list', async () => {
    for (const who of ['bob', 'carol']) {
      expect(FriendsResponseSchema.parse(await json(await get('/api/friends', who)))).toEqual({
        friends: [],
        limit: FRIEND_LIMIT,
      });
      expect(await json(await get('/api/friends/places', who))).toEqual({ places: {} });
      const spots = await get('/api/friends/u_alice/spots', who);
      expect(spots.status).toBe(404);
      // the same answer as for someone who doesn't exist at all
      const nobody = await get('/api/friends/u_nobody/spots', who);
      expect(await spots.text()).toBe(await nobody.text());
    }
  });

  it('signed out: 401 on every friends endpoint', async () => {
    for (const path of ['/api/friends', '/api/friends/places', '/api/invites']) {
      expect((await call(path)).status).toBe(401);
    }
    const res = await call('/api/invites/accept', {
      method: 'POST',
      headers: writeHeaders,
      body: JSON.stringify({ token: 'x'.repeat(43) }),
    });
    expect(res.status).toBe(401);
  });
});

describe('friends see only friends-visible spots, never home or myNote', () => {
  beforeAll(async () => {
    const res = await accept('bob', await invite('alice'));
    expect(res.status).toBe(201);
  });

  it('both sides are friends at once, with names and emoji', async () => {
    const bobs = FriendsResponseSchema.parse(await json(await get('/api/friends', 'bob')));
    expect(bobs.friends.map((f) => [f.id, f.displayName, f.avatarEmoji])).toEqual([
      ['u_alice', 'Alice', '🍜'],
    ]);
    const alices = FriendsResponseSchema.parse(await json(await get('/api/friends', 'alice')));
    expect(alices.friends.map((f) => f.id)).toEqual(['u_bob']);
  });

  it("Bob's cards: Alice's take on shared places, not her private spot", async () => {
    const { places } = FriendPlacesResponseSchema.parse(
      await json(await get('/api/friends/places', 'bob')),
    );
    expect(places[SHARED]).toEqual([
      {
        friend: { id: 'u_alice', displayName: 'Alice', avatarEmoji: '🍜' },
        status: 'been',
        verdict: 'good',
        note: 'alice says hi',
      },
    ]);
    expect(places[PRIVATE]).toBeUndefined();
    expect(places[WANT]?.map((t) => t.friend.id)).toEqual(['u_alice']);
  });

  it("Alice's shared list: friends-visible spots only, a fixed set of fields", async () => {
    const res = await get('/api/friends/u_alice/spots', 'bob');
    expect(res.status).toBe(200);
    const body = FriendSpotsResponseSchema.parse(await res.json());
    const ids = body.spots.map((s) => s.id);
    expect(ids).toContain(SHARED);
    expect(ids).not.toContain(PRIVATE);
    expect(ids).toHaveLength(parseSpots(SEED_SPOTS).length - 1);
    for (const s of body.spots) {
      expect(Object.keys(s).every((k) => FIELDS.has(k))).toBe(true);
    }
  });

  it('nothing Bob can reach carries her home, myNote, why or private one-liner', async () => {
    const all = await everythingVisibleTo('bob');
    for (const secret of [
      SECRET_MY_NOTE,
      SECRET_WHY,
      PRIVATE_NOTE,
      String(HOME.lat),
      String(HOME.lng),
      'myNote',
      'home',
      'why',
      'visibility',
    ]) {
      expect(all).not.toContain(secret);
    }
  });

  it('the page-load reads ride along with the session: one D1 round trip each', async () => {
    for (const path of ['/api/friends', '/api/friends/places']) {
      expect(d1RoundTrips(await get(path, 'bob'))).toBe(1);
    }
  });

  it('Carol, not a friend of either, still sees nothing', async () => {
    expect(await json(await get('/api/friends/places', 'carol'))).toEqual({ places: {} });
    expect((await get('/api/friends/u_alice/spots', 'carol')).status).toBe(404);
    expect((await get('/api/friends/u_bob/spots', 'carol')).status).toBe(404);
    expect(await everythingVisibleTo('carol')).not.toContain('alice says hi');
  });

  it('making a spot private hides it from friends at once (and back)', async () => {
    const alice = cookies.alice ?? '';
    await send('PATCH', `/api/spots/${SHARED}`, alice, { visibility: 'private' });
    const { places } = FriendPlacesResponseSchema.parse(
      await json(await get('/api/friends/places', 'bob')),
    );
    expect(places[SHARED]).toBeUndefined();
    expect(await everythingVisibleTo('bob')).not.toContain('alice says hi');
    await send('PATCH', `/api/spots/${SHARED}`, alice, { visibility: 'friends' });
    expect(await everythingVisibleTo('bob')).toContain('alice says hi');
  });

  it('after unfriending (either side), nothing, both ways', async () => {
    const res = await send('DELETE', '/api/friends/u_alice', cookies.bob ?? '');
    expect(res.status).toBe(204);
    for (const [who, other] of [
      ['bob', 'u_alice'],
      ['alice', 'u_bob'],
    ] as const) {
      expect(await json(await get('/api/friends', who))).toMatchObject({ friends: [] });
      expect(await json(await get('/api/friends/places', who))).toEqual({ places: {} });
      expect((await get(`/api/friends/${other}/spots`, who)).status).toBe(404);
    }
    expect(await everythingVisibleTo('bob')).not.toContain('alice says hi');
    // already gone: 404, from either side
    expect((await send('DELETE', '/api/friends/u_bob', cookies.alice ?? '')).status).toBe(404);
  });
});

const FIELDS = new Set([
  'id',
  'name',
  'address',
  'location',
  'kind',
  'cuisine',
  'price',
  'status',
  'verdict',
  'note',
  'lang',
]);

describe('invite links', () => {
  let n = 0;
  /** A fresh pair of people (and a third) per test: no friendships carried over. */
  async function trio() {
    n += 1;
    const ids = ['a', 'b', 'c'].map((x) => `u_inv${String(n)}${x}`);
    const [a = '', b = '', c = ''] = await Promise.all(ids.map((id) => userSession(id)));
    return { a, b, c, ids };
  }
  const friendRows = async (x: string, y: string) =>
    (
      await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM friendships WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)',
      )
        .bind(x, y, y, x)
        .first<{ n: number }>()
    )?.n;
  const create = async (cookie: string) =>
    CreatedInviteSchema.parse(await json(await send('POST', '/api/invites', cookie)));

  it('stores only a hash of the token; the link is /invite/<token>', async () => {
    const { a } = await trio();
    const made = await create(a);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(made.path).toBe(`/invite/${made.token}`);
    const row = await env.DB.prepare('SELECT * FROM invites WHERE id = ?').bind(made.id).first();
    expect(JSON.stringify(row)).not.toContain(made.token);
    expect(row?.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // about 7 days
    const ttl = Date.parse(made.expiresAt) - Date.parse(made.createdAt);
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('preview says who sent it; accept makes both friends at once (no approval step)', async () => {
    const { a, b, ids } = await trio();
    const { token } = await create(a);
    const preview = await send('POST', '/api/invites/preview', b, { token });
    expect(InvitePreviewSchema.parse(await preview.json())).toEqual({
      from: { displayName: ids[0], avatarEmoji: '🍜' },
      state: 'open',
    });
    const res = await send('POST', '/api/invites/accept', b, { token });
    expect(res.status).toBe(201);
    const body = AcceptInviteResponseSchema.parse(await res.json());
    expect(body).toMatchObject({ already: false, friend: { id: ids[0] } });
    expect(await friendRows(ids[0] ?? '', ids[1] ?? '')).toBe(2);
  });

  it('is single use: a second person gets invite_gone', async () => {
    const { a, b, c, ids } = await trio();
    const { token } = await create(a);
    expect((await send('POST', '/api/invites/accept', b, { token })).status).toBe(201);
    const late = await send('POST', '/api/invites/accept', c, { token });
    expect(late.status).toBe(410);
    expect(await json(late)).toMatchObject({ error: { code: 'invite_gone' } });
    expect(await friendRows(ids[0] ?? '', ids[2] ?? '')).toBe(0);
    expect((await send('POST', '/api/invites/preview', c, { token })).status).toBe(410);
  });

  it('accepting twice: the second says already friends and writes nothing', async () => {
    const { a, b, ids } = await trio();
    const { token } = await create(a);
    expect((await send('POST', '/api/invites/accept', b, { token })).status).toBe(201);
    const again = await send('POST', '/api/invites/accept', b, { token });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ already: true });
    expect(await friendRows(ids[0] ?? '', ids[1] ?? '')).toBe(2);
    // already friends: a *new* link from the same person isn't spent either
    const second = await create(a);
    expect((await send('POST', '/api/invites/accept', b, { token: second.token })).status).toBe(
      200,
    );
    const pending = InvitesResponseSchema.parse(
      await json(await call('/api/invites', { cookie: a })),
    );
    expect(pending.invites.map((i) => i.id)).toEqual([second.id]);
  });

  it('your own link: refused, and still usable by someone else', async () => {
    const { a, b } = await trio();
    const { token } = await create(a);
    const own = await send('POST', '/api/invites/accept', a, { token });
    expect(own.status).toBe(400);
    expect(await json(own)).toMatchObject({ error: { code: 'own_invite' } });
    expect(await json(await send('POST', '/api/invites/preview', a, { token }))).toMatchObject({
      state: 'own',
    });
    expect((await send('POST', '/api/invites/accept', b, { token })).status).toBe(201);
  });

  it('expires after 7 days', async () => {
    const { a, b } = await trio();
    const made = await create(a);
    await env.DB.prepare('UPDATE invites SET expires_at = ? WHERE id = ?')
      .bind(new Date(Date.now() - 1000).toISOString(), made.id)
      .run();
    const res = await send('POST', '/api/invites/accept', b, { token: made.token });
    expect(res.status).toBe(410);
    const pending = InvitesResponseSchema.parse(
      await json(await call('/api/invites', { cookie: a })),
    );
    expect(pending.invites).toEqual([]);
  });

  it('can be revoked by its creator while unused, only by them, only once', async () => {
    const { a, b, c } = await trio();
    const made = await create(a);
    // someone else can't revoke it (and can't tell it exists)
    expect((await send('DELETE', `/api/invites/${made.id}`, c)).status).toBe(404);
    expect((await send('DELETE', `/api/invites/${made.id}`, a)).status).toBe(204);
    expect((await send('DELETE', `/api/invites/${made.id}`, a)).status).toBe(404);
    expect((await send('POST', '/api/invites/accept', b, { token: made.token })).status).toBe(410);
    // a used link can't be revoked
    const used = await create(a);
    await send('POST', '/api/invites/accept', b, { token: used.token });
    expect((await send('DELETE', `/api/invites/${used.id}`, a)).status).toBe(404);
  });

  it('two people racing for one link: exactly one gets it', async () => {
    for (let round = 0; round < 5; round++) {
      const { a, b, c, ids } = await trio();
      const { token } = await create(a);
      const results = await Promise.all([
        send('POST', '/api/invites/accept', b, { token }),
        send('POST', '/api/invites/accept', c, { token }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 410]);
      const total = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM friendships WHERE user_id = ? OR friend_id = ?',
      )
        .bind(ids[0], ids[0])
        .first<{ n: number }>();
      expect(total?.n).toBe(2);
    }
  });

  it('the same person accepting twice at once: one friendship', async () => {
    const { a, b, ids } = await trio();
    const { token } = await create(a);
    const results = await Promise.all([
      send('POST', '/api/invites/accept', b, { token }),
      send('POST', '/api/invites/accept', b, { token }),
    ]);
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true);
    expect(await friendRows(ids[0] ?? '', ids[1] ?? '')).toBe(2);
  });

  it('bad tokens: malformed is 400, unknown is the same 410 as used', async () => {
    const { b } = await trio();
    expect((await send('POST', '/api/invites/accept', b, { token: 'short' })).status).toBe(400);
    expect((await send('POST', '/api/invites/accept', b, {})).status).toBe(400);
    const unknown = await send('POST', '/api/invites/accept', b, { token: 'A'.repeat(43) });
    expect(unknown.status).toBe(410);
  });

  it('accept refuses cross-site requests', async () => {
    const { a, b } = await trio();
    const { token } = await create(a);
    const res = await call('/api/invites/accept', {
      method: 'POST',
      cookie: b,
      headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(403);
  });

  it(`at most ${String(INVITES_PER_DAY)} links a day per person`, async () => {
    const { a, b } = await trio();
    const made = await Promise.all(
      Array.from({ length: INVITES_PER_DAY }, () => send('POST', '/api/invites', a)),
    );
    expect(made.map((r) => r.status)).toEqual(Array(INVITES_PER_DAY).fill(201));
    const over = await send('POST', '/api/invites', a);
    expect(over.status).toBe(429);
    expect(await json(over)).toMatchObject({ error: { code: 'invite_limit' } });
    // someone else's allowance is their own
    expect((await send('POST', '/api/invites', b)).status).toBe(201);
  });

  it(`at most ${String(FRIEND_LIMIT)} friends: the link stays unused`, async () => {
    const { a, b, ids } = await trio();
    const full = ids[0] ?? '';
    const stmts = Array.from(
      { length: FRIEND_LIMIT },
      (_, i) => `u_filler${String(n)}_${String(i)}`,
    ).flatMap((id) => [
      env.DB.prepare(
        "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, 'f', 'x', 'x')",
      ).bind(id),
      env.DB.prepare(
        "INSERT INTO friendships (user_id, friend_id, created_at) VALUES (?, ?, 'x'), (?, ?, 'x')",
      ).bind(full, id, id, full),
    ]);
    await env.DB.batch(stmts);
    const made = await create(a);
    const res = await send('POST', '/api/invites/accept', b, { token: made.token });
    expect(res.status).toBe(409);
    expect(await json(res)).toMatchObject({ error: { code: 'friend_limit' } });
    const pending = InvitesResponseSchema.parse(
      await json(await call('/api/invites', { cookie: a })),
    );
    expect(pending.invites.map((i) => i.id)).toContain(made.id);
  });

  it('deleting an account ends its friendships and links', async () => {
    const { a, b, ids } = await trio();
    await send('POST', '/api/invites/accept', b, { token: (await create(a)).token });
    await create(a);
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(ids[0]).run();
    expect(await friendRows(ids[0] ?? '', ids[1] ?? '')).toBe(0);
    const left = await env.DB.prepare('SELECT COUNT(*) AS n FROM invites WHERE user_id = ?')
      .bind(ids[0])
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
