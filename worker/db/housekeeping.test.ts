/**
 * The hourly housekeeping: what goes and, as much, what must stay.
 */
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import app from '../index';
import { DAY, HOUR, iso } from '../lib/time';
import { sweepHousekeeping } from './housekeeping';

const NOW = Date.parse('2026-10-15T12:00:00.000Z');
const at = (ms: number) => iso(NOW + ms);

async function seed() {
  const db = env.DB;
  await db.batch([
    db.prepare('DELETE FROM sessions'),
    db.prepare('DELETE FROM invites'),
    db.prepare('DELETE FROM daily_counts'),
    db.prepare(
      `INSERT OR IGNORE INTO users (id, display_name, created_at, last_login_at)
       VALUES ('u_hk', 'Hana', 'x', 'x'), ('u_hk2', 'Ivo', 'x', 'x')`,
    ),
  ]);
  const session = (id: string, created: number, expires: number) =>
    db
      .prepare(
        `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
         VALUES (?, 'u_hk', ?, ?, ?)`,
      )
      .bind(id, at(created), at(expires), at(created));
  const invite = (id: string, created: number, extra: { used?: boolean; revoked?: boolean }) =>
    db
      .prepare(
        `INSERT INTO invites (id, token_hash, user_id, created_at, expires_at, used_by, used_at, revoked_at)
         VALUES (?, ?, 'u_hk', ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        `hash-${id}`,
        at(created),
        at(created + 7 * DAY),
        extra.used ? 'u_hk2' : null,
        extra.used ? at(created + HOUR) : null,
        extra.revoked ? at(created + HOUR) : null,
      );
  const count = (key: string, day: string) =>
    db.prepare('INSERT INTO daily_counts (key, day, count) VALUES (?, ?, 1)').bind(key, day);
  await db.batch([
    session('s-live', -DAY, 29 * DAY),
    session('s-expired', -40 * DAY, -HOUR),
    session('s-too-old', -91 * DAY, DAY), // past the 90-day hard limit, expiry not yet
    invite('inv-pending', -2 * DAY, {}),
    invite('inv-used-old', -2 * DAY, { used: true }),
    invite('inv-revoked-old', -3 * DAY, { revoked: true }),
    invite('inv-expired', -8 * DAY, {}),
    // still counts towards today's 20-a-day cap: stays
    invite('inv-revoked-today', -2 * HOUR, { revoked: true }),
    invite('inv-used-today', -3 * HOUR, { used: true }),
    count('register:203.0.113.9', '2026-10-15'),
    count('register:203.0.113.9', '2026-10-14'),
    count('register:203.0.113.9', '2026-10-13'),
    count('register', '2026-10-01'),
  ]);
}

const ids = async (sql: string) =>
  (await env.DB.prepare(sql).all<{ id: string }>()).results.map((r) => r.id).sort();

describe('sweepHousekeeping', () => {
  beforeEach(seed);

  it('deletes dead sessions, spent invites and old counters, and nothing else', async () => {
    expect(await sweepHousekeeping(env.DB, NOW)).toEqual({
      sessions: 2,
      invites: 3,
      dailyCounts: 2,
    });
    expect(await ids('SELECT id FROM sessions')).toEqual(['s-live']);
    expect(await ids('SELECT id FROM invites')).toEqual([
      'inv-pending',
      'inv-revoked-today',
      'inv-used-today',
    ]);
    expect(await ids('SELECT day AS id FROM daily_counts')).toEqual(['2026-10-14', '2026-10-15']);
  });

  it('runs from the hourly cron', async () => {
    const ctx = createExecutionContext();
    await app.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    // the cron runs at the real now: the seeded 2026-10 rows are all well past it or not
    const left = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM daily_counts WHERE key = 'register'",
    ).first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});
