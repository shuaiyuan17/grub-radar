import type { Env } from '../env';
import { newUserId } from '../lib/ids';
import { iso } from '../lib/time';
import type { AppleIdentity } from '../auth/siwa';
import { insertSession, type NewSession } from '../auth/session';
import { DEFAULT_DISPLAY_NAME } from '../../src/contracts/me';

export { DEFAULT_DISPLAY_NAME };

export interface User {
  id: string;
  displayName: string;
  avatarEmoji: string;
  /** Has this person chosen their name (from Apple at sign-up, or saved since)? */
  nameSet: boolean;
}

export interface UserRow {
  id: string;
  display_name: string;
  avatar_emoji: string;
  name_set_at: string | null;
}
export const toUser = (r: UserRow): User => ({
  id: r.id,
  displayName: r.display_name,
  avatarEmoji: r.avatar_emoji,
  nameSet: r.name_set_at !== null,
});

// explicit columns everywhere: never SELECT * (home lives elsewhere, but keep the habit)
const USER_COLUMNS = 'id, display_name, avatar_emoji, name_set_at';

/**
 * Someone's name as anyone else sees it: NULL until they've chosen one, so the
 * stand-in 'you' never reaches a friend, an invite page or the admin page (the
 * app shows a neutral placeholder for NULL). `u` is the users table's alias.
 */
export const publicNameSql = (u: string) =>
  `CASE WHEN ${u}.name_set_at IS NULL THEN NULL ELSE ${u}.display_name END`;

export async function getUser(db: D1Database, id: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT ${USER_COLUMNS} FROM users WHERE id = ?`)
    .bind(id)
    .first<UserRow>();
  return row ? toUser(row) : null;
}

/** A user id for SQL: a bound value (`?`) or a scalar subquery such as a SessionScope. */
export interface UserRef {
  sql: string;
  binds: unknown[];
}

export const userIdRef = (id: string): UserRef => ({ sql: '?', binds: [id] });

type HomeRow = { home_lat: number | null; home_lng: number | null } | undefined;
const toHome = (row: HomeRow) =>
  row?.home_lat == null || row.home_lng == null ? null : { lat: row.home_lat, lng: row.home_lng };

export async function getHome(
  db: D1Database,
  userId: string,
): Promise<{ lat: number; lng: number } | null> {
  return toHome(
    (await homeStatement(db, userIdRef(userId)).first<NonNullable<HomeRow>>()) ?? undefined,
  );
}

/** The home from a homeStatement result (e.g. prefetched with the session). */
export const homeFromResult = (result: D1Result | undefined) =>
  toHome((result?.results as HomeRow[] | undefined)?.[0]);

export function homeStatement(db: D1Database, user: UserRef): D1PreparedStatement {
  return db
    .prepare(`SELECT home_lat, home_lng FROM user_private WHERE user_id = ${user.sql}`)
    .bind(...user.binds);
}

/** Sign-up openness only needs the database when it's "first account only". */
const signupNeedsData = (env: Env) => env.SIGNUP_OPEN !== 'true' && !ownerSub(env);
const ANY_USER_SQL = 'SELECT 1 AS one FROM users LIMIT 1';

/**
 * GET /api/me's reads beyond the profile (which comes with the session): home,
 * and whether anyone has signed up yet when that decides `signupOpen`.
 * Meant for one batch; decode with `readMe`.
 */
export function meStatements(env: Env, db: D1Database, user: UserRef): D1PreparedStatement[] {
  const stmts = [homeStatement(db, user)];
  if (signupNeedsData(env)) stmts.push(db.prepare(ANY_USER_SQL));
  return stmts;
}

export function readMe(
  env: Env,
  results: readonly D1Result[],
): { home: { lat: number; lng: number } | null; signupOpen: boolean } {
  const home = toHome(results[0]?.results[0] as HomeRow);
  const open =
    env.SIGNUP_OPEN === 'true' || (signupNeedsData(env) && (results[1]?.results.length ?? 0) === 0);
  return { home, signupOpen: open };
}

/** Saving a name (any name, even the one you had) counts as choosing it. */
export async function updateUser(
  db: D1Database,
  id: string,
  patch: { displayName?: string; avatarEmoji?: string },
  now = Date.now(),
): Promise<User | null> {
  const name = patch.displayName ?? null;
  const row = await db
    .prepare(
      `UPDATE users SET display_name = COALESCE(?, display_name), avatar_emoji = COALESCE(?, avatar_emoji),
         name_set_at = CASE WHEN ? IS NULL THEN name_set_at ELSE COALESCE(name_set_at, ?) END
       WHERE id = ? RETURNING ${USER_COLUMNS}`,
    )
    .bind(name, patch.avatarEmoji ?? null, name, iso(now), id)
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
  if (!signupNeedsData(env)) return env.SIGNUP_OPEN === 'true';
  return (await env.DB.prepare(ANY_USER_SQL).first()) === null;
}

export type SignInOutcome =
  { kind: 'existing'; userId: string } | { kind: 'created'; userId: string } | { kind: 'closed' };

interface SignInOpts {
  displayName: string | null;
  refreshToken: string | null;
  /** Start this session for whoever signs in (same batch). */
  session?: NewSession;
  /** End this session (the browser's previous one) if the sign-in succeeds. */
  replaces?: string;
}

const IDENTITY = "auth_identities WHERE provider = 'apple' AND provider_sub = ?";

/**
 * Signs in (or up) an Apple identity in ONE D1 batch (one round trip, one
 * transaction), for returning and new users alike:
 *
 *   1-2. returning: bump last_login_at, keep the newest email + refresh token
 *   3-4. new: insert the user only if there's no identity for this `sub` yet
 *        AND admission allows it *inside the INSERT* (NOT EXISTS for the
 *        first-account rule), then the identity only if that user row exists
 *   5.   end the browser's previous session, if anyone got in
 *   6.   start the new session for whoever owns the identity now
 *   7.   read back who that is, and whether we just created them
 *
 * Identity is (provider, sub), never the email. Batches run one at a time, so
 * two simultaneous first sign-ins can't both get in, and the same Apple ID
 * twice at once ends with one account that both requests are signed in to.
 */
export async function signInWithApple(
  env: Env,
  identity: AppleIdentity,
  opts: SignInOpts,
  now = Date.now(),
): Promise<SignInOutcome> {
  const db = env.DB;
  const at = iso(now);
  const rule = admission(env, identity.sub);
  const userId = newUserId();
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`UPDATE users SET last_login_at = ? WHERE id = (SELECT user_id FROM ${IDENTITY})`)
      .bind(at, identity.sub),
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
    db
      .prepare(
        `INSERT INTO users (id, display_name, name_set_at, created_at, last_login_at)
         SELECT ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM ${IDENTITY})
         AND (? = 1 OR (? = 1 AND NOT EXISTS (SELECT 1 FROM users)))`,
      )
      .bind(
        userId,
        opts.displayName ?? DEFAULT_DISPLAY_NAME,
        // Apple's name counts as chosen; the stand-in doesn't (the app will ask)
        opts.displayName === null ? null : at,
        at,
        at,
        identity.sub,
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
  ];
  if (opts.replaces)
    stmts.push(
      db
        .prepare(`DELETE FROM sessions WHERE id = ? AND EXISTS (SELECT 1 FROM ${IDENTITY})`)
        .bind(opts.replaces, identity.sub),
    );
  if (opts.session)
    stmts.push(
      insertSession(db, opts.session, {
        sql: `SELECT user_id FROM ${IDENTITY}`,
        binds: [identity.sub],
      }),
    );
  stmts.push(
    db
      .prepare(`SELECT user_id, user_id = ? AS created FROM ${IDENTITY}`)
      .bind(userId, identity.sub),
  );
  const results = await db.batch<{ user_id: string; created: number }>(stmts);
  const who = results.at(-1)?.results[0];
  if (!who) return { kind: 'closed' };
  return who.created
    ? { kind: 'created', userId: who.user_id }
    : { kind: 'existing', userId: who.user_id };
}

export const DEV_USER = { id: 'u_dev', displayName: 'dev', sub: 'dev-login' } as const;

/**
 * The local test user behind POST /auth/dev-login: the fixed one, or
 * `u_dev-<label>` when a label is given (e2e tests that write get their own).
 */
export async function ensureDevUser(
  db: D1Database,
  label?: string,
  now = Date.now(),
): Promise<string> {
  const at = iso(now);
  const id = label ? `${DEV_USER.id}-${label}` : DEV_USER.id;
  const name = label ? `${DEV_USER.displayName} ${label}` : DEV_USER.displayName;
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, display_name, name_set_at, created_at, last_login_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_login_at = excluded.last_login_at`,
      )
      .bind(id, name, at, at, at),
    // a stand-in Apple identity ('dev-login', 'dev-login-<label>'), so the local
    // ADMIN_APPLE_SUBS can name a dev user and e2e can reach the admin page
    db
      .prepare(
        `INSERT OR IGNORE INTO auth_identities (provider, provider_sub, user_id, created_at)
         VALUES ('apple', ?, ?, ?)`,
      )
      .bind(label ? `${DEV_USER.sub}-${label}` : DEV_USER.sub, id, at),
  ]);
  return id;
}

/** Saves home (user_private, created lazily). Never logged. */
export async function setHome(
  db: D1Database,
  userId: string,
  home: { lat: number; lng: number },
  now = Date.now(),
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET home_lat = excluded.home_lat, home_lng = excluded.home_lng,
         updated_at = excluded.updated_at`,
    )
    .bind(userId, home.lat, home.lng, iso(now))
    .run();
}

export async function clearHome(db: D1Database, userId: string, now = Date.now()): Promise<void> {
  await db
    .prepare(
      'UPDATE user_private SET home_lat = NULL, home_lng = NULL, updated_at = ? WHERE user_id = ?',
    )
    .bind(iso(now), userId)
    .run();
}
