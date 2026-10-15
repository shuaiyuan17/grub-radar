import type { Env } from '../env';
import { newUserId } from '../lib/ids';
import { iso } from '../lib/time';
import type { AppleIdentity } from '../auth/siwa';

export const DEFAULT_DISPLAY_NAME = 'you';

export interface User {
  id: string;
  displayName: string;
  avatarEmoji: string;
}

interface UserRow {
  id: string;
  display_name: string;
  avatar_emoji: string;
}
const toUser = (r: UserRow): User => ({
  id: r.id,
  displayName: r.display_name,
  avatarEmoji: r.avatar_emoji,
});

// explicit columns everywhere: never SELECT * (home lives elsewhere, but keep the habit)
const USER_COLUMNS = 'id, display_name, avatar_emoji';

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

export async function getHome(
  db: D1Database,
  userId: string,
): Promise<{ lat: number; lng: number } | null> {
  const row = await db
    .prepare('SELECT home_lat, home_lng FROM user_private WHERE user_id = ?')
    .bind(userId)
    .first<{ home_lat: number | null; home_lng: number | null }>();
  if (row?.home_lat == null || row.home_lng == null) return null;
  return { lat: row.home_lat, lng: row.home_lng };
}

export async function updateUser(
  db: D1Database,
  id: string,
  patch: { displayName?: string; avatarEmoji?: string },
): Promise<User | null> {
  const row = await db
    .prepare(
      `UPDATE users SET display_name = COALESCE(?, display_name), avatar_emoji = COALESCE(?, avatar_emoji)
       WHERE id = ? RETURNING ${USER_COLUMNS}`,
    )
    .bind(patch.displayName ?? null, patch.avatarEmoji ?? null, id)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

/**
 * "false" still lets the very first account in, so the owner can sign up
 * once and the door shuts behind him without another deploy.
 */
export async function signupOpen(env: Env): Promise<boolean> {
  if (env.SIGNUP_OPEN === 'true') return true;
  const row = await env.DB.prepare('SELECT 1 AS one FROM users LIMIT 1').first();
  return row === null;
}

export type SignInOutcome =
  { kind: 'existing'; userId: string } | { kind: 'created'; userId: string } | { kind: 'closed' };

/**
 * Finds the user for an Apple `sub`, or creates one if sign-up is open.
 * Identity is (provider, sub), never the email.
 */
export async function signInWithApple(
  env: Env,
  identity: AppleIdentity,
  opts: { displayName: string | null; refreshToken: string | null },
  now = Date.now(),
): Promise<SignInOutcome> {
  const db = env.DB;
  const at = iso(now);
  const existing = await db
    .prepare("SELECT user_id FROM auth_identities WHERE provider = 'apple' AND provider_sub = ?")
    .bind(identity.sub)
    .first<{ user_id: string }>();
  if (existing) {
    await db.batch([
      db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(at, existing.user_id),
      // keep the newest refresh token (for revocation) and email; never drop a stored one
      db
        .prepare(
          `UPDATE auth_identities SET email = COALESCE(?, email), email_is_relay = CASE WHEN ? IS NULL THEN email_is_relay ELSE ? END,
           refresh_token = COALESCE(?, refresh_token) WHERE provider = 'apple' AND provider_sub = ?`,
        )
        .bind(
          identity.email,
          identity.email,
          identity.emailIsRelay ? 1 : 0,
          opts.refreshToken,
          identity.sub,
        ),
    ]);
    return { kind: 'existing', userId: existing.user_id };
  }
  if (!(await signupOpen(env))) return { kind: 'closed' };
  const userId = newUserId();
  await db.batch([
    db
      .prepare(
        'INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)',
      )
      .bind(userId, opts.displayName ?? DEFAULT_DISPLAY_NAME, at, at),
    db
      .prepare(
        `INSERT INTO auth_identities (provider, provider_sub, user_id, email, email_is_relay, refresh_token, created_at)
         VALUES ('apple', ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        identity.sub,
        userId,
        identity.email,
        identity.emailIsRelay ? 1 : 0,
        opts.refreshToken,
        at,
      ),
  ]);
  return { kind: 'created', userId };
}

export const DEV_USER = { id: 'u_dev', displayName: 'dev', sub: 'dev-login' } as const;

/** The fixed local test user behind POST /auth/dev-login. */
export async function ensureDevUser(db: D1Database, now = Date.now()): Promise<string> {
  const at = iso(now);
  await db
    .prepare(
      `INSERT INTO users (id, display_name, created_at, last_login_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_login_at = excluded.last_login_at`,
    )
    .bind(DEV_USER.id, DEV_USER.displayName, at, at)
    .run();
  return DEV_USER.id;
}
