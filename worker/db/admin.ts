/**
 * The owner-only admin page's reads. Who is an admin comes from config
 * (ADMIN_APPLE_SUBS: comma-separated Apple `sub`s), matched against the
 * caller's own Apple identity in SQL. Nothing here returns an email, an Apple
 * sub, a user id or a coordinate.
 */
import { SIGNUP_DAYS, type AdminStats } from '../../src/contracts/admin';
import type { Env } from '../env';
import { DAY, isoDate } from '../lib/time';
import { publicNameSql } from './users';

/** The configured admin subs: trimmed, empties dropped. Empty when unset. */
export function adminSubs(env: Pick<Env, 'ADMIN_APPLE_SUBS'>): string[] {
  return (env.ADMIN_APPLE_SUBS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Is this user signed in with an Apple ID listed in ADMIN_APPLE_SUBS? Fails closed. */
export async function isAdmin(
  db: D1Database,
  env: Pick<Env, 'ADMIN_APPLE_SUBS'>,
  userId: string,
): Promise<boolean> {
  const subs = adminSubs(env);
  if (subs.length === 0) return false;
  const row = await db
    .prepare(
      `SELECT 1 AS yes FROM auth_identities
       WHERE user_id = ? AND provider = 'apple'
         AND provider_sub IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(subs))
    .first<{ yes: number }>();
  return row !== null;
}

/** Most users listed on the page (newest first). */
const USERS_SHOWN = 500;

interface UserRow {
  display_name: string | null;
  avatar_emoji: string;
  created_at: string;
  last_seen_at: string;
  spots: number;
  friends: number;
}

/** Everything the page shows, in one round trip. */
export async function adminStats(db: D1Database, now = Date.now()): Promise<AdminStats> {
  const firstDay = isoDate(now - (SIGNUP_DAYS - 1) * DAY);
  const [total, byDay, users] = await db.batch([
    db.prepare('SELECT COUNT(*) AS n FROM users'),
    db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users
         WHERE created_at >= ? GROUP BY day`,
      )
      .bind(firstDay),
    db
      .prepare(
        // last seen: the newest session activity, but never before the last sign-in
        // (signing out deletes the session row, and its last_seen_at with it)
        `SELECT ${publicNameSql('u')} AS display_name, u.avatar_emoji, u.created_at,
           max(u.last_login_at, COALESCE(
             (SELECT MAX(s.last_seen_at) FROM sessions s WHERE s.user_id = u.id), u.last_login_at
           )) AS last_seen_at,
           (SELECT COUNT(*) FROM user_places up WHERE up.user_id = u.id) AS spots,
           (SELECT COUNT(*) FROM friendships f WHERE f.user_id = u.id) AS friends
         FROM users u
         ORDER BY u.created_at DESC, u.id
         LIMIT ?`,
      )
      .bind(USERS_SHOWN),
  ]);
  const counts = new Map(
    ((byDay?.results ?? []) as { day: string; n: number }[]).map((r) => [r.day, r.n]),
  );
  const signupsByDay = Array.from({ length: SIGNUP_DAYS }, (_, i) => {
    const day = isoDate(now - (SIGNUP_DAYS - 1 - i) * DAY);
    return { day, count: counts.get(day) ?? 0 };
  });
  return {
    totalUsers: (total?.results[0] as { n: number } | undefined)?.n ?? 0,
    signupsByDay,
    users: ((users?.results ?? []) as UserRow[]).map((r) => ({
      displayName: r.display_name,
      avatarEmoji: r.avatar_emoji,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      spots: r.spots,
      friends: r.friends,
    })),
  };
}
