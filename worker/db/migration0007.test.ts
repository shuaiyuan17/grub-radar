import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { listFriends } from './friends';
import { getUser } from './users';

/**
 * 0007 (users.name_set_at) on a database at 0006 with rows in it. This file's
 * storage is its own: it applies 0001-0006, writes the kinds of account prod
 * has (Apple's name, the stand-in 'you', a name someone typed, names that only
 * look like 'you'), applies 0007 exactly as `wrangler d1 migrations apply`
 * would, and checks the backfill and that nothing else moved.
 */

const upTo = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= n);
const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;

const USERS = [
  // id, display_name, created_at
  ['u_apple', 'Tess', '2026-10-01T10:00:00.000Z'],
  ['u_you', 'you', '2026-10-15T11:48:33.000Z'],
  ['u_typed', 'Bo 🍜', '2026-10-02T09:00:00.000Z'],
  // not the stand-in: someone's real choices that merely resemble it
  ['u_upper', 'You', '2026-10-03T09:00:00.000Z'],
  ['u_yours', 'yours truly', '2026-10-04T09:00:00.000Z'],
] as const;

let before: unknown[] = [];

beforeAll(async () => {
  for (const t of [
    'daily_counts',
    'agent_grants_revoked',
    'agent_grants_seen',
    'api_tokens',
    'auth_states_used',
    'photo_deletions',
    'photos',
    'invites',
    'friendships',
    'visits',
    'user_places',
    'places',
    'sessions',
    'auth_identities',
    'user_private',
    'users',
    'd1_migrations',
  ])
    await env.DB.exec(`DROP TABLE IF EXISTS ${t}`);
  await applyD1Migrations(env.DB, upTo(6));
  await env.DB.batch([
    ...USERS.map(([id, name, at]) =>
      env.DB.prepare(
        'INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)',
      ).bind(id, name, at, '2026-10-15T12:00:00.000Z'),
    ),
    env.DB.prepare(
      `INSERT INTO friendships (user_id, friend_id, created_at) VALUES
         ('u_apple', 'u_you', '2026-10-15T12:00:00.000Z'), ('u_you', 'u_apple', '2026-10-15T12:00:00.000Z'),
         ('u_apple', 'u_typed', '2026-10-15T12:00:01.000Z'), ('u_typed', 'u_apple', '2026-10-15T12:00:01.000Z')`,
    ),
  ]);
  before = await all(
    'SELECT id, display_name, avatar_emoji, created_at, last_login_at FROM users ORDER BY id',
  );
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('migration 0007: users.name_set_at', () => {
  it('is applied as a nullable column', async () => {
    const names = (await all('SELECT name FROM d1_migrations ORDER BY id')).map(
      (r) => (r as { name: string }).name,
    );
    expect(names).toContain('0007_name_set_at.sql');
    expect(
      await all(
        "SELECT type, \"notnull\", dflt_value FROM pragma_table_info('users') WHERE name = 'name_set_at'",
      ),
    ).toEqual([{ type: 'TEXT', notnull: 0, dflt_value: null }]);
  });

  it('backfill: every name but the stand-in counts as chosen, dated from sign-up', async () => {
    expect(await all('SELECT id, name_set_at FROM users ORDER BY id')).toEqual([
      { id: 'u_apple', name_set_at: '2026-10-01T10:00:00.000Z' },
      { id: 'u_typed', name_set_at: '2026-10-02T09:00:00.000Z' },
      { id: 'u_upper', name_set_at: '2026-10-03T09:00:00.000Z' },
      { id: 'u_you', name_set_at: null },
      { id: 'u_yours', name_set_at: '2026-10-04T09:00:00.000Z' },
    ]);
  });

  it('leaves every other column of every row exactly as it was', async () => {
    expect(
      await all(
        'SELECT id, display_name, avatar_emoji, created_at, last_login_at FROM users ORDER BY id',
      ),
    ).toEqual(before);
  });

  it('the app reads it: the stand-in asks for a name, and friends never see "you"', async () => {
    expect((await getUser(env.DB, 'u_you'))?.nameSet).toBe(false);
    expect((await getUser(env.DB, 'u_apple'))?.nameSet).toBe(true);
    expect((await listFriends(env.DB, 'u_apple')).map((f) => [f.id, f.displayName])).toEqual([
      ['u_you', null],
      ['u_typed', 'Bo 🍜'],
    ]);
  });
});
