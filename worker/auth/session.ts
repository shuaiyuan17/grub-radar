/**
 * Sessions: an opaque 32-byte random token in the `__Host-grub_session`
 * cookie; D1 stores only its SHA-256. 30 days, sliding.
 */
import type { Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../app';
import { randomToken, sha256Hex } from '../lib/crypto';
import { DAY, HOUR, iso } from '../lib/time';

export const SESSION_COOKIE = '__Host-grub_session';
export const SESSION_TTL_MS = 30 * DAY;
/** Extend when less than this is left (one write every ~15 days per active session). */
export const SESSION_REFRESH_BELOW_MS = 15 * DAY;
/** `last_seen_at` is written at most this often. */
export const LAST_SEEN_EVERY_MS = HOUR;

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
}

export async function createSession(
  db: D1Database,
  userId: string,
  userAgent: string | undefined,
  now = Date.now(),
): Promise<{ token: string; session: Session }> {
  const token = randomToken(32);
  const id = await sha256Hex(token);
  const expiresAt = now + SESSION_TTL_MS;
  await db
    .prepare(
      'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, ua_hint) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(id, userId, iso(now), iso(expiresAt), iso(now), uaHint(userAgent))
    .run();
  return { token, session: { id, userId, expiresAt } };
}

interface SessionRow {
  user_id: string;
  expires_at: string;
  last_seen_at: string;
}

export type LoadResult =
  | { kind: 'none' }
  | { kind: 'invalid' } // a cookie that matches no live session: clear it
  | { kind: 'ok'; session: Session; refreshed: boolean };

/** One row read; at most one write (sliding expiry or hourly last_seen). */
export async function loadSession(
  db: D1Database,
  token: string | undefined,
  now = Date.now(),
): Promise<LoadResult> {
  if (!token) return { kind: 'none' };
  if (token.length > 100) return { kind: 'invalid' };
  const id = await sha256Hex(token);
  const row = await db
    .prepare('SELECT user_id, expires_at, last_seen_at FROM sessions WHERE id = ?')
    .bind(id)
    .first<SessionRow>();
  if (!row) return { kind: 'invalid' };
  const expiresAt = Date.parse(row.expires_at);
  if (!(expiresAt > now)) {
    await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
    return { kind: 'invalid' };
  }
  const refresh = expiresAt - now < SESSION_REFRESH_BELOW_MS;
  const seen = now - Date.parse(row.last_seen_at) >= LAST_SEEN_EVERY_MS;
  let next = expiresAt;
  if (refresh) {
    next = now + SESSION_TTL_MS;
    await db
      .prepare('UPDATE sessions SET expires_at = ?, last_seen_at = ? WHERE id = ?')
      .bind(iso(next), iso(now), id)
      .run();
  } else if (seen) {
    await db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(iso(now), id).run();
  }
  return { kind: 'ok', session: { id, userId: row.user_id, expiresAt: next }, refreshed: refresh };
}

export async function deleteSession(db: D1Database, id: string): Promise<void> {
  await db.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run();
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
