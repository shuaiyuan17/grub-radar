/**
 * D1 side of the agent door: personal API tokens (stored only as SHA-256),
 * and when each OAuth grant was last used. Writes that just record use are
 * conditional (at most hourly) and run after the response.
 */
import {
  agentScopes,
  PAT_PREFIX,
  TOKENS_MAX,
  type AgentScope,
  type PersonalToken,
} from '../../src/contracts/agents';
import { randomToken, sha256Hex } from '../lib/crypto';
import { newTokenId } from '../lib/ids';
import { HOUR, iso } from '../lib/time';

/** `last_used_at` is written at most this often (per token, per grant). */
export const USED_EVERY_MS = HOUR;

interface TokenRow {
  id: string;
  name: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
}

const toToken = (r: TokenRow): PersonalToken => ({
  id: r.id,
  name: r.name,
  scopes: agentScopes(r.scopes.split(' ')),
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
});

export async function listTokens(db: D1Database, userId: string): Promise<PersonalToken[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, scopes, created_at, last_used_at FROM api_tokens
       WHERE user_id = ? ORDER BY created_at, id`,
    )
    .bind(userId)
    .all<TokenRow>();
  return results.map(toToken);
}

/**
 * A new token: the secret (returned once) and its listing. null when the
 * person already has TOKENS_MAX (checked in the same statement, so two at
 * once can't both slip past).
 */
export async function createToken(
  db: D1Database,
  userId: string,
  name: string,
  scopes: readonly AgentScope[],
  now = Date.now(),
): Promise<{ token: PersonalToken; secret: string } | null> {
  const secret = `${PAT_PREFIX}${randomToken(32)}`;
  const id = newTokenId();
  // reading needs nothing; writing implies reading too
  const granted = agentScopes(['spots:read', ...scopes]);
  const at = iso(now);
  const res = await db
    .prepare(
      `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM api_tokens WHERE user_id = ?) < ?`,
    )
    .bind(id, userId, name, await sha256Hex(secret), granted.join(' '), at, userId, TOKENS_MAX)
    .run();
  if (!res.meta.changes) return null;
  return {
    secret,
    token: { id, name, scopes: granted, createdAt: at, lastUsedAt: null },
  };
}

/** Deletes one of `userId`'s tokens. false if there was no such token (or not theirs). */
export async function revokeToken(db: D1Database, userId: string, id: string): Promise<boolean> {
  const res = await db
    .prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?')
    .bind(id, userId)
    .run();
  return res.meta.changes > 0;
}

export interface TokenOwner {
  id: string;
  userId: string;
  name: string;
  scopes: AgentScope[];
  lastUsedAt: string | null;
}

/** Who a presented `grub_pat_…` belongs to, or null. One indexed read. */
export async function findToken(db: D1Database, secret: string): Promise<TokenOwner | null> {
  if (!secret.startsWith(PAT_PREFIX) || secret.length > 100) return null;
  const row = await db
    .prepare('SELECT id, user_id, name, scopes, last_used_at FROM api_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(secret))
    .first<{
      id: string;
      user_id: string;
      name: string;
      scopes: string;
      last_used_at: string | null;
    }>();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scopes: agentScopes(row.scopes.split(' ')),
    lastUsedAt: row.last_used_at,
  };
}

/** Records a token's use, unless it was recorded within the hour (then: no write). */
export function touchToken(db: D1Database, id: string, now = Date.now()): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE api_tokens SET last_used_at = ?
       WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`,
    )
    .bind(iso(now), id, iso(now - USED_EVERY_MS));
}

/** Records a grant's use (at most hourly; the conflict branch writes nothing when recent). */
export function touchGrant(
  db: D1Database,
  grantId: string,
  userId: string,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_grants_seen (grant_id, user_id, last_used_at) VALUES (?, ?, ?)
       ON CONFLICT (grant_id) DO UPDATE SET last_used_at = excluded.last_used_at
       WHERE agent_grants_seen.last_used_at < ?`,
    )
    .bind(grantId, userId, iso(now), iso(now - USED_EVERY_MS));
}

/** grant id -> last used, for one person's grants. */
export async function grantsSeen(db: D1Database, userId: string): Promise<Map<string, string>> {
  const { results } = await db
    .prepare('SELECT grant_id, last_used_at FROM agent_grants_seen WHERE user_id = ?')
    .bind(userId)
    .all<{ grant_id: string; last_used_at: string }>();
  return new Map(results.map((r) => [r.grant_id, r.last_used_at]));
}

export async function forgetGrant(db: D1Database, grantId: string, userId: string) {
  await db
    .prepare('DELETE FROM agent_grants_seen WHERE grant_id = ? AND user_id = ?')
    .bind(grantId, userId)
    .run();
}

/**
 * Counts one more `key` today, unless it already reached `cap` today. true if
 * it may go ahead. One write (an upsert that refuses at the cap).
 */
export async function admitDaily(
  db: D1Database,
  key: string,
  cap: number,
  now = Date.now(),
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO daily_counts (key, day, count) VALUES (?, ?, 1)
       ON CONFLICT (key, day) DO UPDATE SET count = count + 1 WHERE count < ?
       RETURNING count`,
    )
    .bind(key, iso(now).slice(0, 10), cap)
    .first<{ count: number }>();
  return row !== null;
}

/** Marks a grant disconnected (strongly consistent; see migration 0008). */
export function revokeGrantStatement(
  db: D1Database,
  grantId: string,
  userId: string,
  now = Date.now(),
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO agent_grants_revoked (grant_id, user_id, revoked_at) VALUES (?, ?, ?)
       ON CONFLICT (grant_id) DO NOTHING`,
    )
    .bind(grantId, userId, iso(now));
}

/** Was this grant disconnected? One indexed read. */
export async function isGrantRevoked(db: D1Database, grantId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 AS x FROM agent_grants_revoked WHERE grant_id = ?')
    .bind(grantId)
    .first();
  return row !== null;
}

/** The ids of `userId`'s grants marked revoked. */
export async function revokedGrants(db: D1Database, userId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare('SELECT grant_id FROM agent_grants_revoked WHERE user_id = ?')
    .bind(userId)
    .all<{ grant_id: string }>();
  return new Set(results.map((r) => r.grant_id));
}

/** Gives back one `key` counted by admitDaily at `now` (a request it let through came to nothing). */
export async function refundDaily(db: D1Database, key: string, now: number) {
  await db
    .prepare('UPDATE daily_counts SET count = count - 1 WHERE key = ? AND day = ? AND count > 0')
    .bind(key, iso(now).slice(0, 10))
    .run();
}
