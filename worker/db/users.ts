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

/** Who may create an account right now, decided from config alone. */
export interface Admission {
  /** Create regardless of who else exists. */
  always: boolean;
  /** Create only if there are no users yet (checked atomically in SQL). */
  ifNoUsers: boolean;
}

const ownerSub = (env: Env) => env.OWNER_APPLE_SUB?.trim() ?? '';

/**
 * SIGNUP_OPEN="true": anyone. Otherwise sign-up is closed, with one way in:
 * OWNER_APPLE_SUB pinned -> only that Apple ID; not pinned -> only the very
 * first account (so the owner can sign up once and the door shuts behind him).
 */
export function admission(env: Env, sub: string): Admission {
  if (env.SIGNUP_OPEN === 'true') return { always: true, ifNoUsers: false };
  const owner = ownerSub(env);
  if (owner) return { always: sub === owner, ifNoUsers: false };
  return { always: false, ifNoUsers: true };
}

/** For GET /api/me: could a new Apple ID sign up right now? */
export async function signupOpen(env: Env): Promise<boolean> {
  if (env.SIGNUP_OPEN === 'true') return true;
  if (ownerSub(env)) return false;
  const row = await env.DB.prepare('SELECT 1 AS one FROM users LIMIT 1').first();
  return row === null;
}

export type SignInOutcome =
  { kind: 'existing'; userId: string } | { kind: 'created'; userId: string } | { kind: 'closed' };

interface SignInOpts {
  displayName: string | null;
  refreshToken: string | null;
}

async function findAppleUser(db: D1Database, sub: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT user_id FROM auth_identities WHERE provider = 'apple' AND provider_sub = ?")
    .bind(sub)
    .first<{ user_id: string }>();
  return row?.user_id ?? null;
}

async function touchAppleUser(
  db: D1Database,
  userId: string,
  identity: AppleIdentity,
  refreshToken: string | null,
  at: string,
) {
  await db.batch([
    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').bind(at, userId),
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
        refreshToken,
        identity.sub,
      ),
  ]);
}

/**
 * Finds the user for an Apple `sub`, or creates one if admission allows.
 * Identity is (provider, sub), never the email.
 *
 * Creation is one D1 batch (one transaction): the user row is inserted only
 * if the admission condition holds *inside the INSERT* (NOT EXISTS for the
 * first-account rule), and the identity row only if that user row now
 * exists. Two simultaneous first sign-ins can't both get in.
 */
export async function signInWithApple(
  env: Env,
  identity: AppleIdentity,
  opts: SignInOpts,
  now = Date.now(),
): Promise<SignInOutcome> {
  const db = env.DB;
  const at = iso(now);
  const existing = await findAppleUser(db, identity.sub);
  if (existing) {
    await touchAppleUser(db, existing, identity, opts.refreshToken, at);
    return { kind: 'existing', userId: existing };
  }

  const rule = admission(env, identity.sub);
  if (!rule.always && !rule.ifNoUsers) return { kind: 'closed' };
  const userId = newUserId();
  let created: boolean;
  try {
    const [insertUser] = await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, display_name, created_at, last_login_at)
           SELECT ?, ?, ?, ? WHERE ? = 1 OR (? = 1 AND NOT EXISTS (SELECT 1 FROM users))`,
        )
        .bind(
          userId,
          opts.displayName ?? DEFAULT_DISPLAY_NAME,
          at,
          at,
          rule.always ? 1 : 0,
          rule.ifNoUsers ? 1 : 0,
        ),
      db
        .prepare(
          `INSERT INTO auth_identities (provider, provider_sub, user_id, email, email_is_relay, refresh_token, created_at)
           SELECT 'apple', ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)`,
        )
        .bind(
          identity.sub,
          userId,
          identity.email,
          identity.emailIsRelay ? 1 : 0,
          opts.refreshToken,
          at,
          userId,
        ),
    ]);
    created = (insertUser?.meta.changes ?? 0) === 1;
  } catch (e) {
    // the same Apple ID signing in twice at once: the identity primary key
    // rejects the second batch (rolled back as a whole); use the first
    const raced = await findAppleUser(db, identity.sub);
    if (raced) return { kind: 'existing', userId: raced };
    throw e;
  }
  if (created) return { kind: 'created', userId };
  // not admitted. If it was the same person racing themselves, they're in anyway.
  const raced = await findAppleUser(db, identity.sub);
  return raced ? { kind: 'existing', userId: raced } : { kind: 'closed' };
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
