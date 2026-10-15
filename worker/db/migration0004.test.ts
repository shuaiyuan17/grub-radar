import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1SpotRepository } from './spots';

/**
 * 0004 (friends, invite links) on a database shaped like production when it
 * ships: one user with an Apple identity, a session, a home and four spots
 * (one been, with a visit). This file's storage is its own: it applies
 * 0001-0003, writes those rows, snapshots every table, applies 0004 exactly as
 * `wrangler d1 migrations apply` would, and checks nothing moved.
 */

const upTo = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= n);
const AT = '2026-10-15T11:48:33.000Z';
const TABLES = [
  'users',
  'auth_identities',
  'sessions',
  'user_private',
  'places',
  'user_places',
  'visits',
];

const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, await all(`SELECT * FROM ${t} ORDER BY 1`)])),
  ) as Record<string, unknown[]>;

let before: Record<string, unknown[]> = {};

beforeAll(async () => {
  for (const t of ['invites', 'friendships', ...[...TABLES].reverse(), 'd1_migrations'])
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  await applyD1Migrations(env.DB, upTo(3));

  const place = (id: string, apple: string) =>
    env.DB.prepare(
      `INSERT INTO places (id, apple_place_id, name, lat, lng, address, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 47.61, -122.33, '1 Fictional St', 'u_owner', ?, ?)`,
    ).bind(id, apple, `Place ${id}`, AT, AT);
  const entry = (id: string, status: string, verdict: string | null) =>
    env.DB.prepare(
      `INSERT INTO user_places (user_id, place_id, kind, status, verdict, note, my_note, created_at, updated_at)
       VALUES ('u_owner', ?, 'food', ?, ?, 'a one-liner', 'a private note', ?, ?)`,
    ).bind(id, status, verdict, AT, AT);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES ('u_owner', 'Owner', ?, ?)",
    ).bind(AT, AT),
    env.DB.prepare(
      `INSERT INTO auth_identities (provider, provider_sub, user_id, email, created_at)
       VALUES ('apple', 'fictional.sub', 'u_owner', 'x@privaterelay.appleid.com', ?)`,
    ).bind(AT),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES ('s1', 'u_owner', ?, '2026-11-14T00:00:00.000Z', ?)`,
    ).bind(AT, AT),
    env.DB.prepare(
      "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES ('u_owner', 47.5, -122.2, ?)",
    ).bind(AT),
    place('p-a', 'IA'),
    place('p-b', 'IB'),
    place('p-c', 'IC'),
    place('p-d', 'ID'),
    entry('p-a', 'been', 'good'),
    entry('p-b', 'want', null),
    entry('p-c', 'want', null),
    entry('p-d', 'want', null),
    env.DB.prepare(
      "INSERT INTO visits (id, user_id, place_id, visited_on, verdict, created_at) VALUES ('v1', 'u_owner', 'p-a', '2026-10-15', 'good', ?)",
    ).bind(AT),
  ]);
  before = await snapshot();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('migration 0004: friends + invites', () => {
  it('is applied, and is the last one', async () => {
    const names = (await all('SELECT name FROM d1_migrations ORDER BY id')).map(
      (r) => (r as { name: string }).name,
    );
    expect(names.at(-1)).toBe('0004_friends.sql');
  });

  it('leaves every existing row exactly as it was', async () => {
    expect(await snapshot()).toEqual(before);
    expect(before.user_places).toHaveLength(4);
  });

  it("doesn't change any existing table's columns", async () => {
    // users keeps its (unused) friend_code: dropping a UNIQUE column isn't additive
    const cols = await all("SELECT name FROM pragma_table_info('users')");
    expect(cols.map((c) => (c as { name: string }).name)).toContain('friend_code');
  });

  it('the app still reads the list; every spot defaults to friends-visible', async () => {
    const spots = await new D1SpotRepository(env.DB, 'u_owner').list();
    expect(spots).toHaveLength(4);
    expect(spots.every((s) => s.visibility === undefined)).toBe(true);
    expect(await all('SELECT DISTINCT visibility FROM user_places')).toEqual([
      { visibility: 'friends' },
    ]);
  });

  it('adds empty friendships and invites tables, with their guards', async () => {
    expect(await all('SELECT * FROM friendships')).toEqual([]);
    expect(await all('SELECT * FROM invites')).toEqual([]);
    await expect(
      env.DB.prepare(
        "INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u_owner', 'u_owner', 'x')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
    await expect(
      env.DB.prepare(
        "INSERT INTO friendships (user_id, friend_id, created_at) VALUES ('u_owner', 'u_ghost', 'x')",
      ).run(),
    ).rejects.toThrow(/FOREIGN KEY/);
    await expect(
      env.DB.prepare(
        "INSERT INTO invites (id, token_hash, user_id, created_at, expires_at, used_by) VALUES ('inv_1', 'h', 'u_owner', 'x', 'y', 'u_owner')",
      ).run(),
    ).rejects.toThrow(/CHECK/);
  });
});
