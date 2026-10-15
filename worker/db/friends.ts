/**
 * Friends and invite links in D1.
 *
 * Privacy lives here, in SQL: every read of someone else's data goes through
 * `friendships` from the viewer's own id (so a non-friend gets no rows, not
 * filtered rows), keeps only `user_places.visibility = 'friends'`, and names
 * its columns. None of them is `my_note`, `why_*`, `order_json`, `tags_json`,
 * or anything from `user_private` (home). Nothing here does SELECT *.
 *
 * A friendship is two rows, (a, b) and (b, a), always written and deleted in
 * the same statement or batch.
 */
import {
  FRIEND_LIMIT,
  INVITE_TTL_DAYS,
  INVITES_PER_DAY,
  type Friend,
  type FriendSpot,
  type FriendTake,
  type InvitePreview,
  type PendingInvite,
} from '../../src/contracts/friends';
import { DATA_LANGS, KINDS, PRICES, VERDICTS, type DataLang } from '../../src/domain/spot';
import { randomToken, sha256Hex } from '../lib/crypto';
import { newInviteId } from '../lib/ids';
import { DAY, iso } from '../lib/time';
import { userIdRef, type UserRef } from './users';

interface PersonRow {
  id: string;
  display_name: string;
  avatar_emoji: string;
}
interface FriendRow extends PersonRow {
  since: string;
}

const toFriend = (r: FriendRow): Friend => ({
  id: r.id,
  displayName: r.display_name,
  avatarEmoji: r.avatar_emoji,
  since: r.since,
});

// narrowers for values read back from CHECK-constrained columns
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (v: string | null): T | undefined =>
    v !== null && (values as readonly string[]).includes(v) ? (v as T) : undefined;
const asVerdict = oneOf(VERDICTS);
const asPrice = oneOf(PRICES);
const asLang = oneOf<DataLang>(DATA_LANGS);
const asKind = (v: string) => oneOf(KINDS)(v) ?? 'food';
const asStatus = (v: string) => (v === 'been' ? 'been' : 'want');
/** '' and NULL both mean "not set". */
const orNone = (s: string | null) => (s === null || s === '' ? undefined : s);

/** Drops undefined keys (the contracts' optional fields want them absent). */
const compact = <T extends Record<string, unknown>>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

// ---------------------------------------------------------------------------
// friends

/** Your friends, oldest friendship first. `user` may be a SessionScope (prefetch). */
export function friendsStatement(db: D1Database, user: UserRef): D1PreparedStatement {
  return db
    .prepare(
      `SELECT u.id, u.display_name, u.avatar_emoji, f.created_at AS since
       FROM friendships f JOIN users u ON u.id = f.friend_id
       WHERE f.user_id = ${user.sql}
       ORDER BY f.created_at, u.id`,
    )
    .bind(...user.binds);
}

export const friendsFromResult = (result: D1Result | undefined): Friend[] =>
  ((result?.results ?? []) as FriendRow[]).map(toFriend);

export async function listFriends(db: D1Database, userId: string): Promise<Friend[]> {
  return friendsFromResult(await friendsStatement(db, userIdRef(userId)).all());
}

/** Ends a friendship, for both sides at once. false when there was none. */
export async function unfriend(db: D1Database, userId: string, friendId: string): Promise<boolean> {
  const res = await db
    .prepare(
      `DELETE FROM friendships
       WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    )
    .bind(userId, friendId, friendId, userId)
    .run();
  return res.meta.changes > 0;
}

interface TakeRow extends PersonRow {
  place_id: string;
  status: string;
  verdict: string | null;
  note: string;
  lang: string | null;
}

/**
 * For each place on your list: your friends who have it on theirs, as they
 * share it (status, verdict, one-liner). Only their 'friends'-visible rows.
 */
export function friendPlacesStatement(db: D1Database, user: UserRef): D1PreparedStatement {
  return db
    .prepare(
      `SELECT theirs.place_id, u.id, u.display_name, u.avatar_emoji,
         theirs.status, theirs.verdict, theirs.note, theirs.lang
       FROM user_places mine
       JOIN friendships f ON f.user_id = mine.user_id
       JOIN user_places theirs ON theirs.user_id = f.friend_id AND theirs.place_id = mine.place_id
       JOIN users u ON u.id = f.friend_id
       WHERE mine.user_id = ${user.sql} AND theirs.visibility = 'friends'
       ORDER BY f.created_at, u.id`,
    )
    .bind(...user.binds);
}

export function friendPlacesFromResult(result: D1Result | undefined): Record<string, FriendTake[]> {
  const places: Record<string, FriendTake[]> = {};
  for (const r of (result?.results ?? []) as TakeRow[]) {
    const take: FriendTake = compact({
      friend: { id: r.id, displayName: r.display_name, avatarEmoji: r.avatar_emoji },
      status: asStatus(r.status),
      verdict: asVerdict(r.verdict),
      note: orNone(r.note),
      lang: asLang(r.lang),
    });
    (places[r.place_id] ??= []).push(take);
  }
  return places;
}

export async function friendPlaces(
  db: D1Database,
  userId: string,
): Promise<Record<string, FriendTake[]>> {
  return friendPlacesFromResult(await friendPlacesStatement(db, userIdRef(userId)).all());
}

interface FriendSpotRow {
  id: string;
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  kind: string;
  cuisine: string;
  price: string | null;
  status: string;
  verdict: string | null;
  note: string;
  lang: string | null;
}

/**
 * A friend's list, as they share it with you. null when you aren't friends
 * (indistinguishable from "no such person"). Both reads go through your own
 * friendship row, in one round trip.
 */
export async function friendSpots(
  db: D1Database,
  viewerId: string,
  friendId: string,
): Promise<{ friend: Friend; spots: FriendSpot[] } | null> {
  const [who, list] = await db.batch([
    db
      .prepare(
        `SELECT u.id, u.display_name, u.avatar_emoji, f.created_at AS since
         FROM friendships f JOIN users u ON u.id = f.friend_id
         WHERE f.user_id = ? AND f.friend_id = ?`,
      )
      .bind(viewerId, friendId),
    db
      .prepare(
        `SELECT p.id, p.name, p.address, p.lat, p.lng,
           up.kind, up.cuisine, up.price, up.status, up.verdict, up.note, up.lang
         FROM friendships f
         JOIN user_places up ON up.user_id = f.friend_id
         JOIN places p ON p.id = up.place_id
         WHERE f.user_id = ? AND f.friend_id = ? AND up.visibility = 'friends'
         ORDER BY up.created_at, p.id`,
      )
      .bind(viewerId, friendId),
  ]);
  const row = (who?.results as FriendRow[] | undefined)?.[0];
  if (!row) return null;
  const spots = ((list?.results ?? []) as FriendSpotRow[]).map((r): FriendSpot =>
    compact({
      id: r.id,
      name: r.name,
      address: orNone(r.address),
      location: { lat: r.lat, lng: r.lng },
      kind: asKind(r.kind),
      cuisine: orNone(r.cuisine),
      price: asPrice(r.price),
      status: asStatus(r.status),
      verdict: asVerdict(r.verdict),
      note: orNone(r.note),
      lang: asLang(r.lang),
    }),
  );
  return { friend: toFriend(row), spots };
}

// ---------------------------------------------------------------------------
// invite links

export const INVITE_TTL_MS = INVITE_TTL_DAYS * DAY;

/**
 * A new link, unless you've made INVITES_PER_DAY in the last 24 hours (checked
 * inside the INSERT, so parallel requests can't overshoot). The token is
 * returned once; only its SHA-256 is stored.
 */
export async function createInvite(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<(PendingInvite & { token: string }) | 'limit'> {
  const token = randomToken(32);
  const id = newInviteId();
  const createdAt = iso(now);
  const expiresAt = iso(now + INVITE_TTL_MS);
  const res = await db
    .prepare(
      `INSERT INTO invites (id, token_hash, user_id, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM invites WHERE user_id = ? AND created_at > ?) < ?`,
    )
    .bind(
      id,
      await sha256Hex(token),
      userId,
      createdAt,
      expiresAt,
      userId,
      iso(now - DAY),
      INVITES_PER_DAY,
    )
    .run();
  if (!res.meta.changes) return 'limit';
  return { id, token, createdAt, expiresAt };
}

/** Your links that still work (unused, unrevoked, unexpired), newest first. */
export async function listInvites(
  db: D1Database,
  userId: string,
  now = Date.now(),
): Promise<PendingInvite[]> {
  const { results } = await db
    .prepare(
      `SELECT id, created_at, expires_at FROM invites
       WHERE user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
       ORDER BY created_at DESC, id DESC LIMIT 50`,
    )
    .bind(userId, iso(now))
    .all<{ id: string; created_at: string; expires_at: string }>();
  return results.map((r) => ({ id: r.id, createdAt: r.created_at, expiresAt: r.expires_at }));
}

/** Revokes one of your own links that still works. false: no such link (of yours), or spent. */
export async function revokeInvite(
  db: D1Database,
  userId: string,
  inviteId: string,
  now = Date.now(),
): Promise<boolean> {
  const res = await db
    .prepare(
      `UPDATE invites SET revoked_at = ?
       WHERE id = ? AND user_id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`,
    )
    .bind(iso(now), inviteId, userId, iso(now))
    .run();
  return res.meta.changes > 0;
}

interface PreviewRow {
  user_id: string;
  display_name: string;
  avatar_emoji: string;
  usable: number;
  friends: number;
}

/**
 * What a link would do for `viewerId`. null: the link can't be used (unknown,
 * used by someone else, revoked, expired). A link you already accepted reads
 * as 'friends' while you still are.
 */
export async function previewInvite(
  db: D1Database,
  viewerId: string,
  token: string,
  now = Date.now(),
): Promise<InvitePreview | null> {
  const at = iso(now);
  const row = await db
    .prepare(
      `SELECT i.user_id, u.display_name, u.avatar_emoji,
         (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?) AS usable,
         EXISTS (SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = i.user_id) AS friends
       FROM invites i JOIN users u ON u.id = i.user_id
       WHERE i.token_hash = ?`,
    )
    .bind(at, viewerId, await sha256Hex(token))
    .first<PreviewRow>();
  if (!row) return null;
  const from = { displayName: row.display_name, avatarEmoji: row.avatar_emoji };
  if (row.friends) return { from, state: 'friends' };
  if (!row.usable) return null;
  return { from, state: row.user_id === viewerId ? 'own' : 'open' };
}

export type AcceptOutcome =
  | { kind: 'accepted'; friend: Friend }
  | { kind: 'already'; friend: Friend }
  | { kind: 'own' }
  | { kind: 'limit' }
  | { kind: 'gone' };

interface AcceptRow {
  user_id: string;
  display_name: string;
  avatar_emoji: string;
  used_by: string | null;
  used_at: string | null;
  usable: number;
  since: string | null;
  mine: number;
  theirs: number;
}

/**
 * Accepts a link: one D1 batch (one round trip, one transaction), so two
 * people racing for the same link can't both get it, and a link is never
 * spent without the friendship it promised:
 *
 *   1. claim the link: only if unused, unrevoked, unexpired, not your own,
 *      you aren't friends already, and both of you are under FRIEND_LIMIT
 *   2-3. the friendship, both ways, only if step 1 claimed it for you just now
 *   4. read back the link and where things stand
 *
 * Already friends: nothing is written and the link stays unused.
 */
export async function acceptInvite(
  db: D1Database,
  viewerId: string,
  token: string,
  now = Date.now(),
): Promise<AcceptOutcome> {
  const at = iso(now);
  const hash = await sha256Hex(token);
  const claimedNow = 'FROM invites WHERE token_hash = ? AND used_by = ? AND used_at = ?';
  const results = await db.batch([
    db
      .prepare(
        `UPDATE invites SET used_by = ?, used_at = ?
         WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
           AND user_id <> ?
           AND NOT EXISTS (SELECT 1 FROM friendships WHERE user_id = ? AND friend_id = invites.user_id)
           AND (SELECT COUNT(*) FROM friendships WHERE user_id = ?) < ?
           AND (SELECT COUNT(*) FROM friendships WHERE user_id = invites.user_id) < ?`,
      )
      .bind(viewerId, at, hash, at, viewerId, viewerId, viewerId, FRIEND_LIMIT, FRIEND_LIMIT),
    db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at)
         SELECT user_id, used_by, ? ${claimedNow}`,
      )
      .bind(at, hash, viewerId, at),
    db
      .prepare(
        `INSERT OR IGNORE INTO friendships (user_id, friend_id, created_at)
         SELECT used_by, user_id, ? ${claimedNow}`,
      )
      .bind(at, hash, viewerId, at),
    db
      .prepare(
        `SELECT i.user_id, u.display_name, u.avatar_emoji, i.used_by, i.used_at,
           (i.used_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > ?) AS usable,
           (SELECT created_at FROM friendships WHERE user_id = ? AND friend_id = i.user_id) AS since,
           (SELECT COUNT(*) FROM friendships WHERE user_id = ?) AS mine,
           (SELECT COUNT(*) FROM friendships WHERE user_id = i.user_id) AS theirs
         FROM invites i JOIN users u ON u.id = i.user_id
         WHERE i.token_hash = ?`,
      )
      .bind(at, viewerId, viewerId, hash),
  ]);
  const row = (results[3]?.results as AcceptRow[] | undefined)?.[0];
  if (!row) return { kind: 'gone' };
  if (row.user_id === viewerId) return { kind: 'own' };
  if (row.since !== null) {
    const friend = toFriend({
      id: row.user_id,
      display_name: row.display_name,
      avatar_emoji: row.avatar_emoji,
      since: row.since,
    });
    const mineNow = row.used_by === viewerId && row.used_at === at;
    return { kind: mineNow ? 'accepted' : 'already', friend };
  }
  if (!row.usable) return { kind: 'gone' };
  if (row.mine >= FRIEND_LIMIT || row.theirs >= FRIEND_LIMIT) return { kind: 'limit' };
  return { kind: 'gone' };
}
