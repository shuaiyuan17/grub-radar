import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { D1SpotRepository } from './spots';

/**
 * 0005 (photos) on a database shaped like production when it ships: two
 * friends, sessions, a home, spots (one private), a visit and a used invite.
 * This file's storage is its own: it applies 0001-0004, writes those rows,
 * snapshots every table, applies 0005 exactly as `wrangler d1 migrations
 * apply` would, and checks nothing moved.
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
  'friendships',
  'invites',
];

const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, await all(`SELECT * FROM ${t} ORDER BY 1`)])),
  ) as Record<string, unknown[]>;

let before: Record<string, unknown[]> = {};

beforeAll(async () => {
  for (const t of ['photo_deletions', 'photos', ...[...TABLES].reverse(), 'd1_migrations'])
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  await applyD1Migrations(env.DB, upTo(4));

  const user = (id: string) =>
    env.DB.prepare(
      'INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)',
    ).bind(id, id, AT, AT);
  const place = (id: string) =>
    env.DB.prepare(
      `INSERT INTO places (id, apple_place_id, name, lat, lng, created_by, created_at, updated_at)
       VALUES (?, ?, ?, 47.61, -122.33, 'u_a', ?, ?)`,
    ).bind(id, `I${id}`, `Place ${id}`, AT, AT);
  const entry = (user: string, id: string, visibility: string) =>
    env.DB.prepare(
      `INSERT INTO user_places (user_id, place_id, kind, status, visibility, created_at, updated_at)
       VALUES (?, ?, 'food', 'want', ?, ?, ?)`,
    ).bind(user, id, visibility, AT, AT);
  await env.DB.batch([
    user('u_a'),
    user('u_b'),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES ('s1', 'u_a', ?, '2026-11-14T00:00:00.000Z', ?)`,
    ).bind(AT, AT),
    env.DB.prepare(
      "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES ('u_a', 47.5, -122.2, ?)",
    ).bind(AT),
    place('p-a'),
    place('p-b'),
    entry('u_a', 'p-a', 'friends'),
    entry('u_a', 'p-b', 'private'),
    entry('u_b', 'p-a', 'friends'),
    env.DB.prepare(
      "INSERT INTO visits (id, user_id, place_id, visited_on, created_at) VALUES ('v1', 'u_a', 'p-a', '2026-10-15', ?)",
    ).bind(AT),
    env.DB.prepare("INSERT INTO friendships VALUES ('u_a', 'u_b', ?), ('u_b', 'u_a', ?)").bind(
      AT,
      AT,
    ),
    env.DB.prepare(
      `INSERT INTO invites (id, token_hash, user_id, created_at, expires_at, used_by, used_at)
       VALUES ('inv_1', 'h', 'u_a', ?, ?, 'u_b', ?)`,
    ).bind(AT, AT, AT),
  ]);
  before = await snapshot();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

const photo = (over: Record<string, unknown> = {}) => {
  const p = {
    id: 'ph_1',
    user_id: 'u_a',
    place_id: 'p-a',
    r2_key: 'u/u_a/p-a/ph_1',
    content_type: 'image/webp',
    width: 1600,
    height: 1200,
    bytes: 1048576,
    caption: null,
    ...over,
  };
  return env.DB.prepare(
    `INSERT INTO photos (id, user_id, place_id, r2_key, content_type, width, height, bytes, caption, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'x')`,
  )
    .bind(
      p.id,
      p.user_id,
      p.place_id,
      p.r2_key,
      p.content_type,
      p.width,
      p.height,
      p.bytes,
      p.caption,
    )
    .run();
};

describe('migration 0005: photos', () => {
  it('is applied, and is the last one', async () => {
    const names = (await all('SELECT name FROM d1_migrations ORDER BY id')).map(
      (r) => (r as { name: string }).name,
    );
    expect(names.at(-1)).toBe('0005_photos.sql');
  });

  it('leaves every existing row exactly as it was', async () => {
    expect(await snapshot()).toEqual(before);
    expect(before.user_places).toHaveLength(3);
  });

  it('the app still reads the list', async () => {
    expect(await new D1SpotRepository(env.DB, 'u_a').list()).toHaveLength(2);
  });

  it('adds empty photos and photo_deletions tables; checks hold the Worker’s limits', async () => {
    expect(await all('SELECT * FROM photos')).toEqual([]);
    expect(await all('SELECT * FROM photo_deletions')).toEqual([]);
    await photo();
    for (const bad of [
      { content_type: 'image/png' },
      { width: 1601 },
      { height: 0 },
      { bytes: 1048577 },
      { caption: '' },
      { caption: 'x'.repeat(141) },
    ])
      await expect(photo({ id: 'ph_bad', r2_key: 'u/u_a/p-a/ph_bad', ...bad })).rejects.toThrow(
        /CHECK/,
      );
    await expect(photo({ id: 'ph_2' })).rejects.toThrow(/UNIQUE/);
    await expect(photo({ id: 'ph_3', r2_key: 'k3', user_id: 'u_ghost' })).rejects.toThrow(
      /FOREIGN KEY/,
    );
  });

  it('deleting a user or a place takes its photo rows', async () => {
    await photo({ id: 'ph_b', user_id: 'u_b', r2_key: 'u/u_b/p-a/ph_b' });
    await env.DB.prepare("DELETE FROM users WHERE id = 'u_b'").run();
    expect(await all("SELECT id FROM photos WHERE user_id = 'u_b'")).toEqual([]);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM user_places WHERE place_id = 'p-a'"),
      env.DB.prepare("DELETE FROM visits WHERE place_id = 'p-a'"),
      env.DB.prepare("DELETE FROM places WHERE id = 'p-a'"),
    ]);
    expect(await all('SELECT id FROM photos')).toEqual([]);
    // every one of those deletes queued its bytes (the trigger fires on cascades too)
    expect(await all('SELECT r2_key FROM photo_deletions ORDER BY r2_key')).toEqual([
      { r2_key: 'u/u_a/p-a/ph_1' },
      { r2_key: 'u/u_b/p-a/ph_b' },
    ]);
  });
});
