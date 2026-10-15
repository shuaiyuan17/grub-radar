/**
 * /api/photos*: photos on the spots on your list.
 *
 *   GET    /api/photos?place=<id>   yours of that place + your friends' (who share it)
 *   POST   /api/photos?place=<id>   upload one (raw WebP/JPEG body, ≤ 1 MB)  -> 201 Photo
 *   GET    /api/photos/:id          the image, to its owner and their friends only
 *   PATCH  /api/photos/:id          { caption } on one of yours               -> Photo
 *   DELETE /api/photos/:id          one of yours                              -> 204
 *
 * Session only: a person's own browser. Who may see a photo is decided in SQL
 * (worker/db/photos.ts); everyone else, signed in or not, gets the same 404 as
 * for a photo that doesn't exist.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  PHOTO_MAX_BYTES,
  PHOTO_MAX_EDGE,
  PHOTO_STORAGE_BYTES,
  PHOTO_TYPES,
  PhotoIdSchema,
  PhotoPatchSchema,
  PHOTOS_PER_SPOT,
  type PlacePhotosResponse,
} from '../../src/contracts/photos';
import { defer, type AppEnv } from '../app';
import { csrf, csrfFor } from '../auth/csrf';
import {
  limitWrites,
  prefetched,
  requireSession,
  sessionUser,
  type Prefetch,
} from '../auth/principal';
import {
  deleteOwnPhoto,
  insertPhoto,
  photoKey,
  placePhotosFromResults,
  placePhotosStatements,
  refusal,
  reservePhotoKey,
  servableFromResult,
  servableStatement,
  setCaption,
  sweepPhotoDeletions,
  usageFromResult,
  usageStatement,
} from '../db/photos';
import { userIdRef } from '../db/users';
import type { Env } from '../env';
import { apiError, readJson } from '../lib/http';
import { newPhotoId } from '../lib/ids';
import { checkImage } from '../lib/imageGuard';
import { iso } from '../lib/time';

type Ctx = Context<AppEnv>;

/** A place id as spots use them (SpotSchema's id rule). */
const PLACE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const placeParam = (c: Ctx): string | null => {
  const place = c.req.query('place') ?? '';
  return place.length <= 100 && PLACE_ID.test(place) ? place : null;
};
const photoIdFrom = (path: string): string | null => {
  const id = /^\/api\/photos\/([^/]+)$/.exec(path)?.[1];
  return id && PhotoIdSchema.safeParse(id).success ? id : null;
};

/**
 * The browser may keep a copy but must ask again before every use: access can
 * end (unfriended, spot made private, photo deleted), and every revalidation
 * goes through the access check. The bytes never change for an id, so the
 * answer is almost always a 304 with no body.
 */
export const PHOTO_CACHE_CONTROL = 'private, no-cache';

/** Not yours, not shared with you, not there, not signed in: all the same answer. */
const noSuchPhoto = (c: Ctx) => apiError(c, 404, 'not_found', 'no such photo');

const LIST = 'GET /api/photos';
const UPLOAD = 'POST /api/photos';
const SERVE = 'GET /api/photos/:id';

/**
 * The reads these requests need, run in the session lookup's batch (see
 * index.ts), so listing, serving and the upload's quota pre-check cost no
 * extra D1 round trip.
 */
export function photosPrefetch(c: Ctx, env: Env): Prefetch | null {
  const path = c.req.path;
  const method = c.req.method;
  if (path === '/api/photos') {
    const place = placeParam(c);
    if (!place) return null;
    if (method === 'GET')
      return { key: LIST, statements: (scope) => placePhotosStatements(env.DB, scope, place) };
    if (method === 'POST')
      return { key: UPLOAD, statements: (scope) => [usageStatement(env.DB, scope, place)] };
    return null;
  }
  const id = method === 'GET' ? photoIdFrom(path) : null;
  return id ? { key: SERVE, statements: (scope) => [servableStatement(env.DB, scope, id)] } : null;
}

/** The upload path, which gets its own body limit (index.ts skips the 64 KB one for it). */
export const isPhotoUpload = (req: { method: string; path: string }) =>
  req.method === 'POST' && req.path === '/api/photos';

/** Per-user brake on uploads (PHOTO_UPLOAD_LIMITER), after WRITE_LIMITER. */
const limitUploads = async (c: Ctx, next: () => Promise<void>) => {
  const { userId } = sessionUser(c.var.principal);
  const { success } = await c.env.PHOTO_UPLOAD_LIMITER.limit({ key: `photo:${userId}` });
  if (!success) return apiError(c, 429, 'rate_limited', 'slow down');
  await next();
};

function refuse(c: Ctx, why: 'no_spot' | 'photo_limit' | 'storage_full') {
  switch (why) {
    case 'no_spot':
      return apiError(c, 404, 'not_found', 'no such spot');
    case 'photo_limit':
      return apiError(
        c,
        409,
        'photo_limit',
        `a spot can hold ${String(PHOTOS_PER_SPOT)} of your photos`,
      );
    case 'storage_full':
      return apiError(
        c,
        409,
        'storage_full',
        `your photos already use ${String(PHOTO_STORAGE_BYTES / 1024 / 1024)} MB`,
      );
  }
}

export const photos = new Hono<AppEnv>();

/** The image itself. Checked before anything else: even a 401 would say "this exists". */
photos.get('/:id', async (c) => {
  const p = c.var.principal;
  const id = photoIdFrom(c.req.path);
  if (p.kind !== 'user' || !id) return noSuchPhoto(c);
  const row = servableFromResult(
    prefetched(c, SERVE)?.[0] ?? (await servableStatement(c.env.DB, userIdRef(p.userId), id).all()),
  );
  if (!row) return noSuchPhoto(c);

  const etag = `"${id}"`;
  const headers = new Headers({
    'Cache-Control': PHOTO_CACHE_CONTROL,
    ETag: etag,
    // one browser, two accounts: a cached copy must not cross from one to the other
    Vary: 'Cookie',
  });
  // only after the access check: a 304 must not tell a stranger the id is real
  const inm = c.req.header('if-none-match');
  if (inm?.split(',').some((t) => t.trim().replace(/^W\//, '') === etag))
    return new Response(null, { status: 304, headers });

  const object = await c.env.PHOTOS.get(row.r2_key);
  if (!object) return noSuchPhoto(c);
  headers.set('Content-Type', row.content_type);
  headers.set('Content-Length', String(object.size));
  headers.set('Content-Disposition', 'inline');
  return new Response(object.body, { headers });
});

photos.use(requireSession);

photos.get('/', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const place = placeParam(c);
  if (!place) return apiError(c, 400, 'bad_request', 'place: which spot?');
  const results =
    prefetched(c, LIST) ??
    (await c.env.DB.batch(placePhotosStatements(c.env.DB, userIdRef(userId), place)));
  const { mine, friends, usedBytes } = placePhotosFromResults(results);
  const body: PlacePhotosResponse = {
    mine,
    friends,
    usage: { bytes: usedBytes, maxBytes: PHOTO_STORAGE_BYTES, perSpot: PHOTOS_PER_SPOT },
  };
  return c.json(body);
});

/**
 * Upload one photo of a spot on your list. The body is the image itself
 * (Content-Type image/webp or image/jpeg), already shrunk and re-encoded by
 * the app. The Worker checks it doesn't lie about its type or size and
 * carries no EXIF/XMP, then stores it in three steps (see below) so the bytes
 * in R2 and the row in D1 can't drift apart, whatever fails.
 */
photos.post(
  '/',
  csrfFor(PHOTO_TYPES),
  limitWrites,
  limitUploads,
  bodyLimit({
    maxSize: PHOTO_MAX_BYTES,
    onError: (c) =>
      apiError(c, 413, 'photo_too_big', `a photo can be ${String(PHOTO_MAX_BYTES)} bytes at most`),
  }),
  async (c) => {
    const { userId } = sessionUser(c.var.principal);
    const place = placeParam(c);
    if (!place) return apiError(c, 400, 'bad_request', 'place: which spot?');

    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.length > PHOTO_MAX_BYTES)
      return apiError(c, 413, 'photo_too_big', 'that photo is too big');
    const image = checkImage(bytes);
    if (!image.ok) {
      if (image.reason === 'metadata')
        return apiError(c, 422, 'image_metadata', `photo carries metadata: ${image.detail}`);
      return apiError(c, 415, 'bad_image', `not a photo we can store: ${image.detail}`);
    }
    const declared = c.req.header('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (declared !== image.type)
      return apiError(c, 415, 'bad_image', `the body is ${image.type}, not ${String(declared)}`);
    if (Math.max(image.width, image.height) > PHOTO_MAX_EDGE)
      return apiError(c, 415, 'bad_image', `${String(PHOTO_MAX_EDGE)}px on the long edge at most`);

    // the cheap no: the counts came with the session lookup (the INSERT checks again)
    const pre = prefetched(c, UPLOAD);
    const early = pre ? refusal(usageFromResult(pre[0]), bytes.length) : null;
    if (early) return refuse(c, early);

    const id = newPhotoId();
    const key = photoKey(userId, place, id);
    const at = iso(Date.now());
    // staged, because R2 and D1 can't share a transaction:
    //   1. the key goes on the outbox as pending (so it's never unknown)
    //   2. the bytes go to R2
    //   3. one batch: the photo row in, the pending row out (or, refused, due now)
    // If 3 fails or times out, it either committed (the row points at the key, so the
    // sweeper keeps the bytes) or it didn't (the pending row ages out and the bytes go).
    await reservePhotoKey(c.env.DB, key, at);
    await c.var.timing.measure('r2_put', () =>
      c.env.PHOTOS.put(key, bytes, { httpMetadata: { contentType: image.type } }),
    );
    const stored = await insertPhoto(c.env.DB, {
      id,
      userId,
      placeId: place,
      key,
      type: image.type,
      width: image.width,
      height: image.height,
      bytes: bytes.length,
      createdAt: at,
    });
    if (!stored.ok) {
      // the refused row's bytes are on the outbox (same batch); sweep them after the answer
      defer(c, sweepPhotoDeletions(c.env.DB, c.env.PHOTOS, { keys: [key] }));
      return refuse(c, stored.why);
    }
    return c.json(stored.photo, 201);
  },
);

photos.patch('/:id', csrf, limitWrites, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, PhotoPatchSchema);
  if (!body.ok) return body.res;
  const photo = await setCaption(c.env.DB, userId, c.req.param('id'), body.data.caption);
  return photo ? c.json(photo) : noSuchPhoto(c);
});

photos.delete('/:id', csrf, limitWrites, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const key = await deleteOwnPhoto(c.env.DB, userId, c.req.param('id'));
  if (!key) return noSuchPhoto(c);
  // the row is gone and its key is on the outbox (trigger); the bytes go after the answer
  defer(c, sweepPhotoDeletions(c.env.DB, c.env.PHOTOS, { keys: [key] }));
  return c.body(null, 204);
});
