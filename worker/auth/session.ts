/**
 * Sessions: an opaque 32-byte random token in the `__Host-grub_session`
 * cookie; D1 stores only its SHA-256. 30 days, sliding.
 *
 * Latency: a lookup is one D1 round trip (the session joined with its user,
 * plus whatever the route reads, in one batch), and never waits on a write.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { randomToken, sha256Hex } from '../lib/crypto';
import type { User } from '../db/users';
import { DAY, HOUR, iso } from '../lib/time';

export const SESSION_COOKIE = '__Host-grub_session';
export const SESSION_TTL_MS = 30 * DAY;
/** Extend when less than this is left (one write every ~15 days per active session). */
export const SESSION_REFRESH_BELOW_MS = 15 * DAY;
/** However active, a session ends this long after sign-in. */
export const SESSION_MAX_AGE_MS = 90 * DAY;
/** `last_seen_at` is written at most this often. */
export const LAST_SEEN_EVERY_MS = HOUR;

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

/** A session about to be created: the cookie token, and the row that goes with it. */
export interface NewSession {
  token: string;
  /** SHA-256 of the token: the row id. */
  id: string;
  createdAt: string;
  expiresAt: string;
  uaHint: string | null;
}

export async function newSession(
  userAgent: string | undefined,
  now = Date.now(),
): Promise<NewSession> {
  const token = randomToken(32);
  return {
    token,
    id: await sha256Hex(token),
    createdAt: iso(now),
    expiresAt: iso(now + SESSION_TTL_MS),
    uaHint: uaHint(userAgent),
  };
}

/** INSERT for `s`, the user id coming from `userSql` (a value `?` or a scalar subquery). */
export function insertSession(
  db: D1Database,
  s: NewSession,
  user: { sql: string; binds: unknown[] },
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ua_hint)
       SELECT ?, user_id, ?, ?, ?, ? FROM (${user.sql}) WHERE user_id IS NOT NULL`,
    )
    .bind(s.id, s.createdAt, s.expiresAt, s.createdAt, s.uaHint, ...user.binds);
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | undefined,
  now = Date.now(),
): Promise<{ token: string; session: Session }> {
  const s = await newSession(userAgent, now);
  await insertSession(db, s, { sql: 'SELECT ? AS user_id', binds: [userId] }).run();
  return { token: s.token, session: { id: s.id, userId, expiresAt: now + SESSION_TTL_MS } };
}

/**
 * `(SELECT user_id FROM sessions WHERE <this session is live>)`, for reads that
 * ride along in the session lookup's batch: they see the same snapshot (a D1
 * batch is one transaction) and can only ever reach this session's user.
 * The liveness test is the same one loadSession applies in JS.
 */
export interface SessionScope {
  sql: string;
  binds: unknown[];
}

export function sessionScope(id: string, now: number): SessionScope {
  return {
    sql: '(SELECT user_id FROM sessions WHERE id = ? AND expires_at > ? AND created_at > ?)',
    binds: [id, iso(now), iso(now - SESSION_MAX_AGE_MS)],
  };
}

interface SessionRow {
  user_id: string;
  created_at: string;
  expires_at: string;
  last_seen_at: string;
  display_name: string;
  avatar_emoji: string;
  name_set_at: string | null;
}

export type LoadResult =
  | { kind: 'none' }
  | { kind: 'invalid' } // a cookie that matches no live session: clear it
  | {
      kind: 'ok';
      session: Session;
      /** The profile, joined in (no separate users query). */
      user: User;
      refreshed: boolean;
      /** Results of `opts.with`, in order. */
      extras: D1Result[];
    };

export interface LoadOptions {
  /**
   * Reads to run in the same round trip as the session lookup, scoped by the
   * session itself. Their results are only handed out for a live session.
   */
  with?: (scope: SessionScope) => D1PreparedStatement[];
  /**
   * Where housekeeping writes go (sliding expiry, last_seen, deleting a dead
   * row). Default: awaited inline. Routes pass ctx.waitUntil, so a lookup is
   * one round trip and never waits on a write.
   */
  defer?: (work: Promise<unknown>) => void;
}

/**
 * One round trip: the session row joined with its user, plus any `with` reads,
 * as one batch. At most one write, and only when due: sliding expiry (under
 * 15 days left extends to 30 days from now, never past 90 days from sign-in),
 * else last_seen_at once an hour.
 */
export async function loadSession(
  db: D1Database,
  token: string | undefined,
  now = Date.now(),
  opts: LoadOptions = {},
): Promise<LoadResult> {
  if (!token) return { kind: 'none' };
  if (token.length > 100) return { kind: 'invalid' };
  const id = await sha256Hex(token);
  const write = (stmt: D1PreparedStatement) => {
    const work = stmt.run();
    if (opts.defer) opts.defer(work);
    return opts.defer ? Promise.resolve() : work;
  };
  const [found, ...extras] = await db.batch([
    db
      .prepare(
        `SELECT s.user_id, s.created_at, s.expires_at, s.last_seen_at, u.display_name, u.avatar_emoji,
           u.name_set_at
         FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
      )
      .bind(id),
    ...(opts.with?.(sessionScope(id, now)) ?? []),
  ]);
  const row = (found?.results[0] as SessionRow | undefined) ?? null;
  if (!row) return { kind: 'invalid' };
  const expiresAt = Date.parse(row.expires_at);
  const hardEnd = Date.parse(row.created_at) + SESSION_MAX_AGE_MS;
  if (!(expiresAt > now) || !(hardEnd > now)) {
    await write(db.prepare('DELETE FROM sessions WHERE id = ?').bind(id));
    return { kind: 'invalid' };
  }
  const extended = Math.min(now + SESSION_TTL_MS, hardEnd);
  const refresh = expiresAt - now < SESSION_REFRESH_BELOW_MS && extended > expiresAt;
  const seen = now - Date.parse(row.last_seen_at) >= LAST_SEEN_EVERY_MS;
  let next = expiresAt;
  if (refresh) {
    next = extended;
    await write(
      db
        .prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
        .bind(iso(next), iso(now), id),
    );
  } else if (seen) {
    await write(db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(iso(now), id));
  }
  return {
    kind: 'ok',
    session: { id, userId: row.user_id, expiresAt: next },
    user: {
      id: row.user_id,
      displayName: row.display_name,
      avatarEmoji: row.avatar_emoji,
      nameSet: row.name_set_at !== null,
    },
    refreshed: refresh,
    extras,
  };
}

/** Ends the session behind `token`, valid or not: one statement, no lookup first. */
export async function revokeSessionToken(db: D1Database, token: string | undefined) {
  if (!token || token.length > 100) return;
  await db
    .prepare('DELETE FROM sessions WHERE id = ?')
    .bind(await sha256Hex(token))
    .run();
}

export function setSessionCookie(c: Context<AppEnv>, token: string, maxAgeMs = SESSION_TTL_MS) {
  setCookie(c, SESSION_COOKIE, token, {
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'Lax',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(c: Context<AppEnv>) {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

export const readSessionCookie = (c: Context<AppEnv>) => getCookie(c, SESSION_COOKIE);

/** "Safari on iPhone"-style label for a later "your sessions" list. Never the raw UA. */
export function uaHint(ua: string | undefined): string | null {
  if (!ua) return null;
  const device = ua.includes('iPhone')
    ? 'iPhone'
    : ua.includes('iPad')
      ? 'iPad'
      : ua.includes('Android')
        ? 'Android'
        : /Macintosh|Mac OS X/.test(ua)
          ? 'Mac'
          : ua.includes('Windows')
            ? 'Windows'
            : ua.includes('Linux')
              ? 'Linux'
              : null;
  const browser = ua.includes('Edg/')
    ? 'Edge'
    : /Firefox\/|FxiOS/.test(ua)
      ? 'Firefox'
      : /Chrome\/|CriOS/.test(ua)
        ? 'Chrome'
        : ua.includes('Safari/')
          ? 'Safari'
          : null;
  if (!device && !browser) return null;
  if (!device) return browser;
  if (!browser) return device;
  return `${browser} on ${device}`;
}
