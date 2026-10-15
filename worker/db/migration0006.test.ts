import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { spendState } from './authStates';

/**
 * 0006 (single-use SIWA states) on a database at 0005 with rows in it. This
 * file's storage is its own: it applies 0001-0005, writes a user and a
 * session, snapshots, applies 0006 exactly as `wrangler d1 migrations apply`
 * would, and checks nothing moved.
 */

const upTo = (n: number) => env.TEST_MIGRATIONS.filter((m) => Number(m.name.slice(0, 4)) <= n);
const AT = '2026-10-15T11:48:33.000Z';
const TABLES = ['users', 'auth_identities', 'sessions'];

const all = async (sql: string) => (await env.DB.prepare(sql).all()).results;
const snapshot = async () =>
  Object.fromEntries(
    await Promise.all(TABLES.map(async (t) => [t, await all(`SELECT * FROM ${t} ORDER BY 1`)])),
  ) as Record<string, unknown[]>;

let before: Record<string, unknown[]> = {};
/** Right after this migration (later ones may add columns of their own, as 0007 does). */
let after: Record<string, unknown[]> = {};

beforeAll(async () => {
  for (const t of [
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
  await applyD1Migrations(env.DB, upTo(5));
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, display_name, created_at, last_login_at) VALUES ('u_a', 'a', ?, ?)",
    ).bind(AT, AT),
    env.DB.prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
       VALUES ('s1', 'u_a', ?, '2026-11-14T00:00:00.000Z', ?)`,
    ).bind(AT, AT),
  ]);
  before = await snapshot();
  await applyD1Migrations(env.DB, upTo(6));
  after = await snapshot();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

describe('migration 0006: auth_states_used', () => {
  it('is applied, and leaves every existing row exactly as it was', async () => {
    const names = (await all('SELECT name FROM d1_migrations ORDER BY id')).map(
      (r) => (r as { name: string }).name,
    );
    expect(names).toContain('0006_auth_states_used.sql');
    expect(after).toEqual(before);
    expect(await all('SELECT * FROM auth_states_used')).toEqual([]);
  });

  it('a jti is spendable once; expired rows are swept on the next spend', async () => {
    const now = Date.parse(AT);
    expect(await spendState(env.DB, { jti: 'jti-aaaaaaaaaaaaaaaa', iat: now }, now)).toBe(true);
    expect(await spendState(env.DB, { jti: 'jti-aaaaaaaaaaaaaaaa', iat: now }, now)).toBe(false);
    // still there while its state could be valid (10 min + 1 min slack)...
    await spendState(env.DB, { jti: 'jti-bbbbbbbbbbbbbbbb', iat: now }, now + 10 * 60_000);
    expect(await all('SELECT jti FROM auth_states_used ORDER BY jti')).toHaveLength(2);
    // ...and gone after
    await spendState(
      env.DB,
      { jti: 'jti-cccccccccccccccc', iat: now + 12 * 60_000 },
      now + 12 * 60_000,
    );
    expect(await all('SELECT jti FROM auth_states_used ORDER BY jti')).toEqual([
      { jti: 'jti-cccccccccccccccc' },
    ]);
  });
});
