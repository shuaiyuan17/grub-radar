/**
 * Hourly housekeeping (the cron in worker/index.ts): rows that can no longer
 * do anything are deleted, so the database keeps no more than it needs. The
 * Privacy Policy (worker/legal/pages.ts) states these rules; keep them in step.
 *
 *   sessions      expired (expires_at passed) or past the 90-day hard limit.
 *                 A lookup deletes a dead row it meets; this catches the
 *                 ones nobody presents again.
 *   invites       spent (used or revoked) or expired, once created more than
 *                 a day ago: the 20-a-day cap counts the last day's links, so
 *                 a revoked link must keep counting until then.
 *   daily_counts  per-day counters (some keyed by IP address) older than
 *                 yesterday: the caps only ever read today's row.
 */
import { SESSION_MAX_AGE_MS } from '../auth/session';
import { DAY, iso } from '../lib/time';

/** Per-day counters kept: today's (the only one the caps read) and yesterday's. */
export const DAILY_COUNTS_KEEP_DAYS = 2;

export interface Housekeeping {
  sessions: number;
  invites: number;
  dailyCounts: number;
}

/** One batch, three deletes. Returns how many rows each removed. */
export async function sweepHousekeeping(db: D1Database, now = Date.now()): Promise<Housekeeping> {
  const at = iso(now);
  const [sessions, invites, counts] = await db.batch([
    db
      .prepare('DELETE FROM sessions WHERE expires_at <= ? OR created_at <= ?')
      .bind(at, iso(now - SESSION_MAX_AGE_MS)),
    db
      .prepare(
        `DELETE FROM invites WHERE created_at <= ?
         AND (used_at IS NOT NULL OR revoked_at IS NOT NULL OR expires_at <= ?)`,
      )
      .bind(iso(now - DAY), at),
    db
      .prepare('DELETE FROM daily_counts WHERE day < ?')
      .bind(iso(now - (DAILY_COUNTS_KEEP_DAYS - 1) * DAY).slice(0, 10)),
  ]);
  return {
    sessions: sessions?.meta.changes ?? 0,
    invites: invites?.meta.changes ?? 0,
    dailyCounts: counts?.meta.changes ?? 0,
  };
}
