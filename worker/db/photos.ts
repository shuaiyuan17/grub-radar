/**
 * Photos in D1 (the bytes are in R2; see migrations/0005_photos.sql).
 *
 * Who may see a photo is decided here, in SQL, the same way friends' spots
 * are (worker/db/friends.ts): the owner, or someone reaching the owner through
 * their own `friendships` row while the owner's entry for that place is
 * 'friends'-visible. Anyone else gets no row, which the route turns into the
 * same 404 as a photo that doesn't exist.
 *
 * Both caps (PHOTOS_PER_SPOT per spot, PHOTO_STORAGE_BYTES per person) are
 * checked inside the INSERT itself, so parallel uploads can't overshoot: D1
 * runs one statement at a time, and the statement only inserts if the counts
 * it reads still leave room.
 */
import {
  PHOTO_STORAGE_BYTES,
  PHOTOS_PER_SPOT,
  photoUrl,
  type Photo,
  type PhotoType,
} from '../../src/contracts/photos';
import { userIdRef, type UserRef } from './users';

interface PhotoRow {
  id: string;
  user_id: string;
  width: number;
  height: number;
  bytes: number;
  caption: string | null;
  created_at: string;
}

const toPhoto = (r: PhotoRow): Photo => ({
  id: r.id,
  width: r.width,
  height: r.height,
  bytes: r.bytes,
  ...(r.caption ? { caption: r.caption } : {}),
  createdAt: r.created_at,
  url: photoUrl(r.id),
});

const PHOTO_COLUMNS = 'ph.id, ph.user_id, ph.width, ph.height, ph.bytes, ph.caption, ph.created_at';

/** Where a photo's bytes go in R2. Prefixed by owner, so an account can be swept by prefix. */
export const photoKey = (userId: string, placeId: string, photoId: string) =>
  `u/${userId}/${placeId}/${photoId}`;
export const userPhotoPrefix = (userId: string) => `u/${userId}/`;

/** "Can `viewer` see the photo `ph`?" as SQL, `?`s bound by `viewerBinds`. */
const VISIBLE_TO = (viewer: string) => `(
  ph.user_id = ${viewer}
  OR EXISTS (
    SELECT 1 FROM friendships f
    JOIN user_places up ON up.user_id = f.friend_id
    WHERE f.user_id = ${viewer} AND f.friend_id = ph.user_id
      AND up.place_id = ph.place_id AND up.visibility = 'friends'
  )
)`;

// ---------------------------------------------------------------------------
// reading

/** What GET /api/photos/:id needs, only if `viewer` may see it. */
export interface ServablePhoto {
  r2_key: string;
  content_type: PhotoType;
  bytes: number;
}

export function servableStatement(
  db: D1Database,
  viewer: UserRef,
  photoId: string,
): D1PreparedStatement {
  return db
    .prepare(
      `SELECT ph.r2_key, ph.content_type, ph.bytes FROM photos ph
       WHERE ph.id = ? AND ${VISIBLE_TO(viewer.sql)}`,
    )
    .bind(photoId, ...viewer.binds, ...viewer.binds);
}

export const servableFromResult = (result: D1Result | undefined): ServablePhoto | null =>
  ((result?.results ?? []) as ServablePhoto[])[0] ?? null;

/**
 * The place page's photos: yours of this place, your friends' of it (only
 * friends who share that spot), and how much of your storage you've used.
 */
export function placePhotosStatements(
  db: D1Database,
  viewer: UserRef,
  placeId: string,
): D1PreparedStatement[] {
  return [
    db
      .prepare(
        `SELECT ${PHOTO_COLUMNS} FROM photos ph
         WHERE ph.user_id = ${viewer.sql} AND ph.place_id = ?
         ORDER BY ph.created_at, ph.id`,
      )
      .bind(...viewer.binds, placeId),
    db
      .prepare(
        `SELECT ${PHOTO_COLUMNS} FROM friendships f
         JOIN user_places up ON up.user_id = f.friend_id AND up.place_id = ?
           AND up.visibility = 'friends'
         JOIN photos ph ON ph.user_id = f.friend_id AND ph.place_id = up.place_id
         WHERE f.user_id = ${viewer.sql}
         ORDER BY f.created_at, ph.created_at, ph.id`,
      )
      .bind(placeId, ...viewer.binds),
    usageStatement(db, viewer, placeId),
  ];
}

export interface PlacePhotos {
  mine: Photo[];
  friends: Record<string, Photo[]>;
  usedBytes: number;
}

export function placePhotosFromResults(results: D1Result[]): PlacePhotos {
  const [mine, theirs, usage] = results;
  const friends: Record<string, Photo[]> = {};
  for (const r of (theirs?.results ?? []) as PhotoRow[])
    (friends[r.user_id] ??= []).push(toPhoto(r));
  return {
    mine: ((mine?.results ?? []) as PhotoRow[]).map(toPhoto),
    friends,
    usedBytes: usageFromResult(usage).usedBytes,
  };
}

export async function placePhotos(
  db: D1Database,
  viewerId: string,
  placeId: string,
): Promise<PlacePhotos> {
  return placePhotosFromResults(
    await db.batch(placePhotosStatements(db, userIdRef(viewerId), placeId)),
  );
}

interface UsageRow {
  on_list: number;
  here: number;
  used: number;
}
export interface Usage {
  onList: boolean;
  /** Your photos of this spot. */
  here: number;
  /** Bytes of all your photos. */
  usedBytes: number;
}

/** Is the place on your list, how many photos of yours it has, and your total bytes. */
export function usageStatement(db: D1Database, user: UserRef, placeId: string) {
  return db
    .prepare(
      `SELECT
         EXISTS (SELECT 1 FROM user_places WHERE user_id = ${user.sql} AND place_id = ?) AS on_list,
         (SELECT COUNT(*) FROM photos WHERE user_id = ${user.sql} AND place_id = ?) AS here,
         (SELECT COALESCE(SUM(bytes), 0) FROM photos WHERE user_id = ${user.sql}) AS used`,
    )
    .bind(...user.binds, placeId, ...user.binds, placeId, ...user.binds);
}

export function usageFromResult(result: D1Result | undefined): Usage {
  const row = ((result?.results ?? []) as UsageRow[])[0];
  return { onList: Boolean(row?.on_list), here: row?.here ?? 0, usedBytes: row?.used ?? 0 };
}

/** Why an upload can't be stored, judged from usage (before or after the INSERT). */
export function refusal(
  u: Usage,
  bytes: number,
): 'no_spot' | 'photo_limit' | 'storage_full' | null {
  if (!u.onList) return 'no_spot';
  if (u.here >= PHOTOS_PER_SPOT) return 'photo_limit';
  if (u.usedBytes + bytes > PHOTO_STORAGE_BYTES) return 'storage_full';
  return null;
}

// ---------------------------------------------------------------------------
// writing

export interface NewPhoto {
  id: string;
  userId: string;
  placeId: string;
  key: string;
  type: PhotoType;
  width: number;
  height: number;
  bytes: number;
  createdAt: string;
}

/**
 * Stores the row, only if the place is on the uploader's list, the spot has
 * room (PHOTOS_PER_SPOT) and so does the person (PHOTO_STORAGE_BYTES), all
 * judged inside the one INSERT. One round trip: the read after it says why,
 * when nothing was inserted.
 */
export async function insertPhoto(
  db: D1Database,
  p: NewPhoto,
): Promise<
  { ok: true; photo: Photo } | { ok: false; why: 'no_spot' | 'photo_limit' | 'storage_full' }
> {
  const [inserted, after] = await db.batch([
    db
      .prepare(
        `INSERT INTO photos (id, user_id, place_id, r2_key, content_type, width, height, bytes, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM user_places WHERE user_id = ? AND place_id = ?)
           AND (SELECT COUNT(*) FROM photos WHERE user_id = ? AND place_id = ?) < ?
           AND (SELECT COALESCE(SUM(bytes), 0) FROM photos WHERE user_id = ?) + ? <= ?`,
      )
      .bind(
        p.id,
        p.userId,
        p.placeId,
        p.key,
        p.type,
        p.width,
        p.height,
        p.bytes,
        p.createdAt,
        p.userId,
        p.placeId,
        p.userId,
        p.placeId,
        PHOTOS_PER_SPOT,
        p.userId,
        p.bytes,
        PHOTO_STORAGE_BYTES,
      ),
    usageStatement(db, userIdRef(p.userId), p.placeId),
  ]);
  if (inserted?.meta.changes) {
    return {
      ok: true,
      photo: toPhoto({
        id: p.id,
        user_id: p.userId,
        width: p.width,
        height: p.height,
        bytes: p.bytes,
        caption: null,
        created_at: p.createdAt,
      }),
    };
  }
  return { ok: false, why: refusal(usageFromResult(after), p.bytes) ?? 'photo_limit' };
}

/** Deletes one of your photos. Its R2 key, or null when it isn't yours (or doesn't exist). */
export async function deleteOwnPhoto(
  db: D1Database,
  userId: string,
  photoId: string,
): Promise<string | null> {
  const row = await db
    .prepare('DELETE FROM photos WHERE id = ? AND user_id = ? RETURNING r2_key')
    .bind(photoId, userId)
    .first<{ r2_key: string }>();
  return row?.r2_key ?? null;
}

/** Sets (or, with '', clears) the caption on one of your photos. null: not yours. */
export async function setCaption(
  db: D1Database,
  userId: string,
  photoId: string,
  caption: string,
): Promise<Photo | null> {
  const row = await db
    .prepare(
      `UPDATE photos SET caption = ? WHERE id = ? AND user_id = ?
       RETURNING id, user_id, width, height, bytes, caption, created_at`,
    )
    .bind(caption.trim() === '' ? null : caption.trim(), photoId, userId)
    .first<PhotoRow>();
  return row ? toPhoto(row) : null;
}

/** Deletes your photos of one spot (with the spot, in its batch), returning their R2 keys. */
export function deleteSpotPhotosStatement(
  db: D1Database,
  userId: string,
  placeId: string,
): D1PreparedStatement {
  return db
    .prepare('DELETE FROM photos WHERE user_id = ? AND place_id = ? RETURNING r2_key')
    .bind(userId, placeId);
}

export const keysFromResult = (result: D1Result | undefined): string[] =>
  ((result?.results ?? []) as { r2_key: string }[]).map((r) => r.r2_key);

// ---------------------------------------------------------------------------
// R2

/** Deletes objects from R2, 1000 keys per call (R2's limit). Failures are logged, not thrown. */
export async function deleteObjects(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 1000) {
    try {
      await bucket.delete(keys.slice(i, i + 1000));
    } catch (e) {
      // the D1 rows are gone, so nothing can serve these; they're orphans, not leaks
      console.error('R2 delete failed', e instanceof Error ? e.message : e, keys.length);
    }
  }
}

/**
 * Every photo object of one person, by prefix, whether or not D1 still has
 * rows for them. For account deletion: the D1 rows go with the user row
 * (ON DELETE CASCADE); this takes the bytes. Returns how many were deleted.
 */
export async function purgeUserPhotos(bucket: R2Bucket, userId: string): Promise<number> {
  const prefix = userPhotoPrefix(userId);
  let cursor: string | undefined;
  let n = 0;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    n += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}
