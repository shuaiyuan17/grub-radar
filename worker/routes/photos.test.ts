import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  PHOTO_MAX_BYTES,
  PHOTO_STORAGE_BYTES,
  PHOTOS_PER_SPOT,
  PhotoSchema,
  PlacePhotosResponseSchema,
  type Photo,
} from '../../src/contracts/photos';
import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../index';
import { ORIGIN } from '../test/helpers';
import {
  deleteOwnPhoto,
  insertPhoto,
  PENDING_GRACE_MS,
  reservePhotoKey,
  MAX_SWEEP_ATTEMPTS,
  photoKey,
  purgeUserPhotos,
  sweepPhotoDeletions,
} from '../db/photos';
import { newPhotoId } from '../lib/ids';
import { call, d1RoundTrips, send, userSession } from '../test/helpers';
import { exifBody, jpeg, segment, vp8x, webp, webpParts, xmpBody } from '../test/images';

/**
 * Photos through the Worker, with Miniflare's R2: what's accepted (and what
 * isn't: wrong types, EXIF/XMP, oversize), both caps (also under parallel
 * uploads), who can see a photo (owner, friends while the spot is shared;
 * everyone else the same 404), and that deleting a photo, a spot or an
 * account takes the bytes too. Fictional people and places.
 */

const cookies: Record<string, string> = {};
const who = (name: string) => cookies[name] ?? '';

async function person(name: string) {
  cookies[name] = await userSession(`u_${name}`, name);
}

/** A place on `user`'s list (inserted directly: photos only care that the entry exists). */
async function spot(user: string, place: string, visibility: 'friends' | 'private' = 'friends') {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO places (id, name, lat, lng, created_at, updated_at)
       VALUES (?, ?, 47.6, -122.3, 'x', 'x')`,
    ).bind(place, `Place ${place}`),
    env.DB.prepare(
      `INSERT INTO user_places (user_id, place_id, kind, status, visibility, created_at, updated_at)
       VALUES (?, ?, 'food', 'want', ?, 'x', 'x')`,
    ).bind(`u_${user}`, place, visibility),
  ]);
}

async function befriend(a: string, b: string) {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO friendships VALUES (?, ?, 'x')").bind(`u_${a}`, `u_${b}`),
    env.DB.prepare("INSERT INTO friendships VALUES (?, ?, 'x')").bind(`u_${b}`, `u_${a}`),
  ]);
}

const uploadHeaders = (type: string) => ({
  'content-type': type,
  'x-grub-request': '1',
  'sec-fetch-site': 'same-origin',
});

function upload(
  cookie: string,
  place: string,
  body: Uint8Array = webp(),
  type = 'image/webp',
  headers: Record<string, string> = {},
) {
  return call(`/api/photos?place=${place}`, {
    method: 'POST',
    cookie,
    headers: { ...uploadHeaders(type), ...headers },
    body,
  });
}

async function uploaded(cookie: string, place: string, body?: Uint8Array, type?: string) {
  const res = await upload(cookie, place, body, type);
  expect(res.status).toBe(201);
  return PhotoSchema.parse(await res.json());
}

const errorCode = async (res: Response) =>
  (await res.json<{ error: { code: string } }>()).error.code;

/** Every R2 key under a prefix. */
async function keys(prefix: string): Promise<string[]> {
  return (await env.PHOTOS.list({ prefix })).objects.map((o) => o.key);
}

/** The cron, as Cloudflare would run it. */
async function runCron() {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController(), env, ctx);
  await waitOnExecutionContext(ctx);
}

const outbox = async () =>
  (
    await env.DB.prepare('SELECT r2_key, attempts FROM photo_deletions ORDER BY r2_key').all<{
      r2_key: string;
      attempts: number;
    }>()
  ).results;

const rows = async (sql: string, ...binds: unknown[]) =>
  (
    await env.DB.prepare(sql)
      .bind(...binds)
      .all()
  ).results;

beforeAll(async () => {
  for (const p of ['ana', 'ben', 'cyd', 'dot', 'eve', 'fay', 'gus', 'hal']) await person(p);
  await befriend('ana', 'ben');
  await spot('ana', 'shared-noodles');
  await spot('ana', 'secret-cafe', 'private');
  await spot('ben', 'shared-noodles');
});

describe('upload', () => {
  it('stores a WebP: 201, the photo, its bytes in R2 under the owner’s prefix', async () => {
    const body = webp({ width: 1600, height: 1200 });
    const photo = await uploaded(who('ana'), 'shared-noodles', body);
    expect(photo).toMatchObject({ width: 1600, height: 1200, bytes: body.length });
    expect(photo.url).toBe(`/api/photos/${photo.id}`);
    const object = await env.PHOTOS.get(photoKey('u_ana', 'shared-noodles', photo.id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(body);
    expect(object!.httpMetadata?.contentType).toBe('image/webp');
  });

  it('stores a JPEG (the fallback where WebP can’t be encoded)', async () => {
    const photo = await uploaded(
      who('ana'),
      'shared-noodles',
      jpeg({ width: 900, height: 1600 }),
      'image/jpeg',
    );
    expect(photo).toMatchObject({ width: 900, height: 1600 });
  });

  it('serves its own upload back: bytes, type, private long cache, ETag, 304', async () => {
    const body = jpeg({ width: 640, height: 480 });
    const photo = await uploaded(who('ana'), 'shared-noodles', body, 'image/jpeg');
    const res = await call(photo.url, { cookie: who('ana') });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
    // cached, but asked again every time: access can end, and each ask passes the check
    expect(res.headers.get('cache-control')).toBe('private, no-cache');
    expect(res.headers.get('cache-control')).not.toContain('immutable');
    expect(res.headers.get('etag')).toBe(`"${photo.id}"`);
    expect(res.headers.get('vary')).toBe('Cookie');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(body);
    // the session lookup carries the access check: one D1 round trip
    expect(d1RoundTrips(res)).toBe(1);

    const again = await call(photo.url, {
      cookie: who('ana'),
      headers: { 'if-none-match': `"${photo.id}"` },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
  });

  it('lists your photos of a spot with your usage', async () => {
    const res = await call('/api/photos?place=shared-noodles', { cookie: who('ana') });
    expect(res.status).toBe(200);
    const list = PlacePhotosResponseSchema.parse(await res.json());
    expect(list.mine.length).toBeGreaterThanOrEqual(3);
    expect(list.usage).toMatchObject({ maxBytes: PHOTO_STORAGE_BYTES, perSpot: PHOTOS_PER_SPOT });
    expect(list.usage.bytes).toBe(list.mine.reduce((n, p) => n + p.bytes, 0));
    expect(d1RoundTrips(res)).toBe(1);
  });

  it('sets and clears a caption', async () => {
    const photo = await uploaded(who('ben'), 'shared-noodles');
    const set = await send('PATCH', photo.url, who('ben'), { caption: '  the dumplings  ' });
    expect(set.status).toBe(200);
    expect(PhotoSchema.parse(await set.json()).caption).toBe('the dumplings');
    const cleared = PhotoSchema.parse(
      await (await send('PATCH', photo.url, who('ben'), { caption: '' })).json(),
    );
    expect(cleared.caption).toBeUndefined();
    const long = await send('PATCH', photo.url, who('ben'), { caption: 'x'.repeat(141) });
    expect(long.status).toBe(400);
  });
});

describe('upload: what the Worker refuses', () => {
  const place = 'refusals';
  beforeAll(async () => {
    await spot('cyd', place);
  });

  async function refused(res: Response, status: number, code: string) {
    expect(res.status).toBe(status);
    expect(await errorCode(res)).toBe(code);
  }

  it('a JPEG carrying EXIF with a GPS position: 422, nothing stored', async () => {
    const withGps = jpeg({ before: [segment(0xe1, exifBody({ gps: true }))] });
    await refused(await upload(who('cyd'), place, withGps, 'image/jpeg'), 422, 'image_metadata');
  });

  it('XMP in a JPEG, EXIF or XMP in a WebP: 422', async () => {
    const { chunk, vp8l } = webpParts;
    await refused(
      await upload(who('cyd'), place, jpeg({ before: [segment(0xe1, xmpBody())] }), 'image/jpeg'),
      422,
      'image_metadata',
    );
    await refused(
      await upload(
        who('cyd'),
        place,
        webp({ chunks: [vp8x(10, 10, 0x08), vp8l(10, 10), chunk('EXIF', exifBody())] }),
      ),
      422,
      'image_metadata',
    );
    await refused(
      await upload(
        who('cyd'),
        place,
        webp({ chunks: [vp8x(10, 10, 0x04), vp8l(10, 10), chunk('XMP ', xmpBody())] }),
      ),
      422,
      'image_metadata',
    );
  });

  it('anything that isn’t WebP or JPEG, whatever it says it is: 415', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    await refused(await upload(who('cyd'), place, png, 'image/webp'), 415, 'bad_image');
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await refused(await upload(who('cyd'), place, svg, 'image/jpeg'), 415, 'bad_image');
    // a real JPEG declared as WebP
    await refused(await upload(who('cyd'), place, jpeg(), 'image/webp'), 415, 'bad_image');
    await refused(
      await upload(who('cyd'), place, new Uint8Array(), 'image/webp'),
      415,
      'bad_image',
    );
  });

  it('a content type a cross-site form could send, or no CSRF header: 403', async () => {
    for (const type of ['text/plain', 'multipart/form-data', 'application/x-www-form-urlencoded'])
      await refused(await upload(who('cyd'), place, webp(), type), 403, 'csrf');
    // other image types aren't accepted either
    await refused(await upload(who('cyd'), place, webp(), 'image/png'), 403, 'csrf');
    await refused(
      await upload(who('cyd'), place, webp(), 'image/webp', { 'x-grub-request': '0' }),
      403,
      'csrf',
    );
    await refused(
      await upload(who('cyd'), place, webp(), 'image/webp', { 'sec-fetch-site': 'cross-site' }),
      403,
      'csrf',
    );
  });

  it('bigger than 1600px on the long edge, by its own header: 415', async () => {
    await refused(
      await upload(who('cyd'), place, webp({ width: 1601, height: 100 })),
      415,
      'bad_image',
    );
    await refused(
      await upload(who('cyd'), place, jpeg({ width: 100, height: 4000 }), 'image/jpeg'),
      415,
      'bad_image',
    );
  });

  it('over 1 MB: 413, before anything is read', async () => {
    const big = new Uint8Array(PHOTO_MAX_BYTES + 1);
    big.set(webp());
    await refused(await upload(who('cyd'), place, big), 413, 'photo_too_big');
  });

  it('a place that isn’t on your list (or isn’t a place id): 404 / 400', async () => {
    await refused(await upload(who('cyd'), 'shared-noodles'), 404, 'not_found');
    await refused(await upload(who('cyd'), 'Not A Place'), 400, 'bad_request');
  });

  it('signed out: 401', async () => {
    const res = await call(`/api/photos?place=${place}`, {
      method: 'POST',
      headers: uploadHeaders('image/webp'),
      body: webp(),
    });
    expect(res.status).toBe(401);
  });

  // every refusal above must leave neither a row nor an object behind
  it('left nothing behind: no rows, no objects', async () => {
    expect(await rows("SELECT id FROM photos WHERE user_id = 'u_cyd'")).toEqual([]);
    await expect.poll(() => keys('u/u_cyd/')).toEqual([]);
  });
});

describe('caps', () => {
  it(`${String(PHOTOS_PER_SPOT)} photos per spot: the next is a 409, other spots still have room`, async () => {
    await spot('dot', 'full-up');
    await spot('dot', 'roomy');
    for (let i = 0; i < PHOTOS_PER_SPOT; i++) await uploaded(who('dot'), 'full-up');
    const over = await upload(who('dot'), 'full-up');
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe('photo_limit');
    await expect.poll(() => keys('u/u_dot/full-up/')).toHaveLength(PHOTOS_PER_SPOT);
    await uploaded(who('dot'), 'roomy');
  });

  it('parallel uploads to one spot: exactly 6 land, the rest leave no object behind', async () => {
    await spot('eve', 'rush');
    const results = await Promise.all(Array.from({ length: 10 }, () => upload(who('eve'), 'rush')));
    const statuses = results.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(PHOTOS_PER_SPOT);
    expect(statuses.filter((s) => s === 409)).toHaveLength(10 - PHOTOS_PER_SPOT);
    expect(await rows("SELECT id FROM photos WHERE user_id = 'u_eve'")).toHaveLength(
      PHOTOS_PER_SPOT,
    );
    await expect.poll(() => keys('u/u_eve/')).toHaveLength(PHOTOS_PER_SPOT);
  });

  it('the INSERT itself enforces the per-spot cap (no pre-check involved)', async () => {
    await spot('fay', 'direct');
    const attempt = () => {
      const id = newPhotoId();
      return insertPhoto(env.DB, {
        id,
        userId: 'u_fay',
        placeId: 'direct',
        key: photoKey('u_fay', 'direct', id),
        type: 'image/webp',
        width: 10,
        height: 10,
        bytes: 100,
        createdAt: new Date().toISOString(),
      });
    };
    const outcomes = await Promise.all(Array.from({ length: 9 }, attempt));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(PHOTOS_PER_SPOT);
    expect(outcomes.filter((o) => !o.ok).map((o) => o.why)).toEqual([
      'photo_limit',
      'photo_limit',
      'photo_limit',
    ]);
  });

  it('200 MB per person, across spots: a 409 when the next photo wouldn’t fit', async () => {
    await spot('gus', 'archive');
    await spot('gus', 'next');
    // stand-in rows for 200 MB minus 1000 bytes (the cap counts rows, not R2)
    const filler = 1024 * 1024;
    const n = Math.floor((PHOTO_STORAGE_BYTES - 1000) / filler);
    const stmts = [];
    for (let i = 0; i < n; i++) {
      const id = newPhotoId();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO photos (id, user_id, place_id, r2_key, content_type, width, height, bytes, created_at)
           VALUES (?, 'u_gus', 'archive', ?, 'image/webp', 10, 10, ?, 'x')`,
        ).bind(id, `filler/${id}`, filler),
      );
    }
    const rest = PHOTO_STORAGE_BYTES - 1000 - n * filler;
    const id = newPhotoId();
    stmts.push(
      env.DB.prepare(
        `INSERT INTO photos (id, user_id, place_id, r2_key, content_type, width, height, bytes, created_at)
         VALUES (?, 'u_gus', 'next', ?, 'image/webp', 10, 10, ?, 'x')`,
      ).bind(id, `filler/${id}`, rest),
    );
    await env.DB.batch(stmts);

    // ~1 KB doesn't fit in what's left; a tiny one does
    const fits = webp({ width: 10, height: 10 });
    expect(fits.length).toBeLessThan(1000);
    // a valid WebP over 1000 bytes: a bigger bitstream (padding chunks aren't allowed)
    const { chunk } = webpParts;
    const padded = webp({
      chunks: [
        chunk('VP8L', [0x2f, ...new Array<number>(4).fill(0), ...new Array<number>(1100).fill(0)]),
      ],
    });
    expect(padded.length).toBeGreaterThan(1000);
    const over = await upload(who('gus'), 'next', padded);
    expect(over.status).toBe(409);
    expect(await errorCode(over)).toBe('storage_full');
    await expect.poll(() => keys('u/u_gus/')).toEqual([]);
    await uploaded(who('gus'), 'next', fits);
  });

  it('uploads are rate limited per person (20 a minute)', async () => {
    await spot('hal', 'busy');
    const statuses: number[] = [];
    // refused bodies still count: the brake runs before anything is read
    for (let i = 0; i < 24; i++)
      statuses.push((await upload(who('hal'), 'busy', new Uint8Array([1, 2, 3]))).status);
    expect(statuses.filter((s) => s === 415).length).toBeLessThanOrEqual(20);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe('who can see a photo', () => {
  let shared: Photo;
  let secret: Photo;
  let unknownBody = '';
  beforeAll(async () => {
    await person('stranger');
    shared = await uploaded(who('ana'), 'shared-noodles');
    secret = await uploaded(who('ana'), 'secret-cafe');
    const unknown = await call(`/api/photos/${newPhotoId()}`, { cookie: who('stranger') });
    expect(unknown.status).toBe(404);
    unknownBody = await unknown.text();
  });

  const view = (photo: Photo, cookie?: string) => call(photo.url, { cookie });

  it('the owner sees both', async () => {
    expect((await view(shared, who('ana'))).status).toBe(200);
    expect((await view(secret, who('ana'))).status).toBe(200);
  });

  it('a friend sees the shared spot’s photo, not the private spot’s', async () => {
    expect((await view(shared, who('ben'))).status).toBe(200);
    const res = await view(secret, who('ben'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(unknownBody);
  });

  it('a stranger and a signed-out visitor get the same 404 as a photo that doesn’t exist', async () => {
    for (const cookie of [who('stranger'), undefined]) {
      for (const photo of [shared, secret]) {
        const res = await view(photo, cookie);
        expect(res.status).toBe(404);
        expect(await res.text()).toBe(unknownBody);
        expect(res.headers.get('etag')).toBeNull();
        expect(res.headers.get('cache-control')).toBe('no-store');
      }
    }
    // a guessed ETag doesn't get a stranger a 304
    const res = await call(shared.url, {
      cookie: who('stranger'),
      headers: { 'if-none-match': `"${shared.id}"` },
    });
    expect(res.status).toBe(404);
  });

  it('the friend sees it on the place’s list under the owner’s id; a stranger sees nothing', async () => {
    const ben = PlacePhotosResponseSchema.parse(
      await (await call('/api/photos?place=shared-noodles', { cookie: who('ben') })).json(),
    );
    expect(ben.friends.u_ana?.map((p) => p.id)).toContain(shared.id);
    const benSecret = PlacePhotosResponseSchema.parse(
      await (await call('/api/photos?place=secret-cafe', { cookie: who('ben') })).json(),
    );
    expect(benSecret.friends).toEqual({});
    const stranger = PlacePhotosResponseSchema.parse(
      await (await call('/api/photos?place=shared-noodles', { cookie: who('stranger') })).json(),
    );
    expect(stranger).toMatchObject({ mine: [], friends: {} });
  });

  it('only the owner can caption or delete', async () => {
    for (const cookie of [who('ben'), who('stranger')]) {
      expect((await send('PATCH', shared.url, cookie, { caption: 'mine now' })).status).toBe(404);
      expect((await send('DELETE', shared.url, cookie)).status).toBe(404);
    }
    expect((await view(shared, who('ana'))).status).toBe(200);
  });

  it('the spot going private, or unfriending, ends a friend’s access at once', async () => {
    const photo = await uploaded(who('ben'), 'shared-noodles');
    expect((await view(photo, who('ana'))).status).toBe(200);
    expect(
      (await send('PATCH', '/api/spots/shared-noodles', who('ben'), { visibility: 'private' }))
        .status,
    ).toBe(200);
    expect((await view(photo, who('ana'))).status).toBe(404);
    await send('PATCH', '/api/spots/shared-noodles', who('ben'), { visibility: 'friends' });
    expect((await view(photo, who('ana'))).status).toBe(200);

    expect((await send('DELETE', '/api/friends/u_ana', who('ben'))).status).toBe(204);
    expect((await view(photo, who('ana'))).status).toBe(404);
    expect((await view(shared, who('ben'))).status).toBe(404);
    await befriend('ana', 'ben');
  });
});

describe('delete', () => {
  it('your photo: 204, the row and the bytes go, the URL is a 404', async () => {
    await spot('ana', 'delete-one');
    const photo = await uploaded(who('ana'), 'delete-one');
    expect((await send('DELETE', photo.url, who('ana'))).status).toBe(204);
    await expect.poll(() => keys('u/u_ana/delete-one/')).toEqual([]);
    expect((await call(photo.url, { cookie: who('ana') })).status).toBe(404);
    expect((await send('DELETE', photo.url, who('ana'))).status).toBe(404);
  });

  it('a spot: its photos go with it (rows and bytes), other spots’ stay', async () => {
    await spot('ana', 'delete-spot');
    const a = await uploaded(who('ana'), 'delete-spot');
    const b = await uploaded(who('ana'), 'delete-spot');
    const before = await keys('u/u_ana/');
    expect((await send('DELETE', '/api/spots/delete-spot', who('ana'))).status).toBe(204);
    expect(await rows('SELECT id FROM photos WHERE id IN (?, ?)', a.id, b.id)).toEqual([]);
    await expect.poll(() => keys('u/u_ana/delete-spot/')).toEqual([]);
    await expect.poll(() => keys('u/u_ana/')).toHaveLength(before.length - 2);
    // Ben's photos of a place Ana removes aren't hers to take
    expect((await call('/api/photos?place=shared-noodles', { cookie: who('ben') })).status).toBe(
      200,
    );
  });

  it('an account: rows cascade with the user, the bytes go via the outbox, nobody else’s', async () => {
    await person('zed');
    await spot('zed', 'last-meal');
    await uploaded(who('zed'), 'last-meal');
    await uploaded(who('zed'), 'last-meal');
    const others = (await keys('u/')).filter((k) => !k.startsWith('u/u_zed/'));

    await env.DB.prepare("DELETE FROM users WHERE id = 'u_zed'").run();
    expect(await rows("SELECT id FROM photos WHERE user_id = 'u_zed'")).toEqual([]);
    // the cascade fired the trigger: both keys are queued
    expect((await outbox()).filter((r) => r.r2_key.startsWith('u/u_zed/'))).toHaveLength(2);
    await runCron();
    expect(await keys('u/u_zed/')).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect((await keys('u/')).sort()).toEqual(others.sort());
  });

  it('purgeUserPhotos also takes objects no row knows (an upload that died between R2 and D1)', async () => {
    await env.PHOTOS.put('u/u_ghost/somewhere/ph_x', new Uint8Array([1]));
    await env.PHOTOS.put('u/u_ghostly/elsewhere/ph_y', new Uint8Array([1]));
    expect(await purgeUserPhotos(env.PHOTOS, 'u_ghost')).toBe(1);
    expect(await keys('u/u_ghost/')).toEqual([]);
    expect(await keys('u/u_ghostly/')).toHaveLength(1);
  });
});

describe('the deletion outbox', () => {
  const failingBucket = {
    delete: () => Promise.reject(new Error('R2 is having a moment')),
  } as unknown as R2Bucket;

  it('a failed R2 delete keeps the key queued (attempt counted); the cron finishes it', async () => {
    await spot('ana', 'flaky');
    const photo = await uploaded(who('ana'), 'flaky');
    const key = photoKey('u_ana', 'flaky', photo.id);
    expect(await deleteOwnPhoto(env.DB, 'u_ana', photo.id)).toBe(key);
    expect(await outbox()).toEqual([{ r2_key: key, attempts: 0 }]);

    expect(await sweepPhotoDeletions(env.DB, failingBucket, { keys: [key] })).toEqual({
      deleted: 0,
      failed: 1,
      kept: 0,
    });
    expect(await outbox()).toEqual([{ r2_key: key, attempts: 1 }]);
    expect(await keys('u/u_ana/flaky/')).toEqual([key]);
    // nobody can see it meanwhile: the row is gone
    expect((await call(photo.url, { cookie: who('ana') })).status).toBe(404);

    await runCron();
    expect(await keys('u/u_ana/flaky/')).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('the cron gives up on a key after MAX_SWEEP_ATTEMPTS (left for a person to look at)', async () => {
    await env.DB.prepare(
      "INSERT INTO photo_deletions (r2_key, created_at, attempts) VALUES ('u/stuck/p/ph_z', 'x', ?)",
    )
      .bind(MAX_SWEEP_ATTEMPTS)
      .run();
    await env.PHOTOS.put('u/stuck/p/ph_z', new Uint8Array([1]));
    await runCron();
    expect(await keys('u/stuck/')).toEqual(['u/stuck/p/ph_z']);
    expect(await outbox()).toEqual([{ r2_key: 'u/stuck/p/ph_z', attempts: MAX_SWEEP_ATTEMPTS }]);
    await env.DB.prepare('DELETE FROM photo_deletions').run();
  });

  it('a refused upload’s pending key turns due in the same batch as the refusal, then is swept', async () => {
    // straight to the INSERT (no pre-check): a place that isn't on the list
    const id = 'ph_00000000000000000000000000';
    await reservePhotoKey(env.DB, photoKey('u_ana', 'nowhere', id), new Date().toISOString());
    await env.PHOTOS.put(photoKey('u_ana', 'nowhere', id), new Uint8Array([1]));
    const refused = await insertPhoto(env.DB, {
      id,
      userId: 'u_ana',
      placeId: 'nowhere',
      key: photoKey('u_ana', 'nowhere', id),
      type: 'image/webp',
      width: 10,
      height: 10,
      bytes: 10,
      createdAt: new Date().toISOString(),
    });
    expect(refused).toEqual({ ok: false, why: 'no_spot' });
    expect(await outbox()).toEqual([{ r2_key: photoKey('u_ana', 'nowhere', id), attempts: 0 }]);
    await runCron();
    expect(await keys('u/u_ana/nowhere/')).toEqual([]);
    expect(await outbox()).toEqual([]);
  });
});

describe('upload: when D1 fails at the last step', () => {
  /**
   * env.DB, except the batch that inserts the photo row fails: after it
   * committed (the answer was lost: a timeout) or instead of it (rolled back).
   */
  function flakyDb(mode: 'after-commit' | 'rolled-back'): D1Database {
    const real = env.DB;
    return new Proxy(real, {
      get(target, prop) {
        if (prop === 'batch')
          return async (stmts: D1PreparedStatement[]) => {
            const sql = stmts.map((st) =>
              String((st as unknown as { statement?: string }).statement),
            );
            if (!sql.some((q) => q.includes('INSERT INTO photos'))) return target.batch(stmts);
            if (mode === 'after-commit') await target.batch(stmts);
            throw new Error('D1_ERROR: Network connection lost.');
          };
        const v: unknown = Reflect.get(target, prop);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  }

  const uploadWith = (db: D1Database, place: string) =>
    worker.request(
      `${ORIGIN}/api/photos?place=${place}`,
      {
        method: 'POST',
        headers: { ...uploadHeaders('image/webp'), cookie: who('ana') },
        body: webp(),
      },
      { ...env, DB: db },
    );
  const age = () =>
    env.DB.prepare('UPDATE photo_deletions SET created_at = ?')
      .bind(new Date(Date.now() - PENDING_GRACE_MS - 60_000).toISOString())
      .run();

  it('committed, answer lost: a 500, but the photo is there and its bytes stay', async () => {
    await spot('ana', 'lost-answer');
    const res = await uploadWith(flakyDb('after-commit'), 'lost-answer');
    expect(res.status).toBe(500);
    const [row] = (await rows(
      "SELECT id, r2_key FROM photos WHERE user_id = 'u_ana' AND place_id = 'lost-answer'",
    )) as { id: string; r2_key: string }[];
    expect(row).toBeDefined();
    // the same batch took the pending outbox row out
    expect(await outbox()).toEqual([]);
    await runCron();
    expect(await keys('u/u_ana/lost-answer/')).toEqual([row?.r2_key]);
    expect((await call(`/api/photos/${String(row?.id)}`, { cookie: who('ana') })).status).toBe(200);
  });

  it('rolled back: a 500, the key stays pending, the cron deletes the bytes once it’s old', async () => {
    await spot('ana', 'rolled-back');
    const res = await uploadWith(flakyDb('rolled-back'), 'rolled-back');
    expect(res.status).toBe(500);
    expect(await rows("SELECT id FROM photos WHERE place_id = 'rolled-back'")).toEqual([]);
    const [stored] = await keys('u/u_ana/rolled-back/');
    expect(stored).toBeDefined();
    expect(await outbox()).toEqual([{ r2_key: stored, attempts: 0 }]);
    // young: a request could still be working on it, so the cron leaves it
    await runCron();
    expect(await keys('u/u_ana/rolled-back/')).toEqual([stored]);
    await age();
    await runCron();
    expect(await keys('u/u_ana/rolled-back/')).toEqual([]);
    expect(await outbox()).toEqual([]);
  });

  it('the sweeper never deletes bytes a photos row points at; it drops the outbox row', async () => {
    await spot('ana', 'still-mine');
    const photo = await uploaded(who('ana'), 'still-mine');
    const key = photoKey('u_ana', 'still-mine', photo.id);
    for (const pending of [0, 1]) {
      await env.DB.prepare(
        'INSERT INTO photo_deletions (r2_key, created_at, pending) VALUES (?, ?, ?)',
      )
        .bind(key, new Date(0).toISOString(), pending)
        .run();
      expect(await sweepPhotoDeletions(env.DB, env.PHOTOS)).toMatchObject({
        kept: 1,
        deleted: 0,
      });
      expect(await outbox()).toEqual([]);
      expect(await keys('u/u_ana/still-mine/')).toEqual([key]);
    }
    expect((await call(photo.url, { cookie: who('ana') })).status).toBe(200);
  });
});
