import { z } from 'zod/mini';

/**
 * Wire shapes for photos: /api/photos*.
 *
 * A photo belongs to one entry on someone's list (their `user_places` row).
 * Its bytes live in R2 and are only ever served by the Worker, at
 * `/api/photos/:id`, to the owner and to the owner's friends while that spot
 * is shared with friends. There are no public URLs.
 *
 * The browser shrinks and re-encodes every photo before it leaves the phone
 * (WebP, or JPEG where WebP can't be encoded), which drops all metadata,
 * including where the photo was taken. The Worker refuses anything that still
 * carries EXIF or XMP, so a client that skips that step can't store a location.
 */

/** The only formats the Worker stores. */
export const PHOTO_TYPES = ['image/webp', 'image/jpeg'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

/** Hard ceiling for one stored photo (the client aims for 150-300 KB). */
export const PHOTO_MAX_BYTES = 1024 * 1024;
/** Longest edge the client produces; the Worker refuses anything bigger. */
export const PHOTO_MAX_EDGE = 1600;
/** Photos one person can attach to one spot. */
export const PHOTOS_PER_SPOT = 6;
/** Total photo storage per person. */
export const PHOTO_STORAGE_BYTES = 200 * 1024 * 1024;
/** Longest caption. */
export const CAPTION_MAX = 140;

/** 'ph_' + ULID (lowercase base32). */
export const PhotoIdSchema = z.string().check(z.regex(/^ph_[0-9a-z]{26}$/, 'not a photo id'));

export const photoUrl = (id: string) => `/api/photos/${id}`;

export const PhotoSchema = z.strictObject({
  id: z.string(),
  width: z.number(),
  height: z.number(),
  bytes: z.number(),
  caption: z.optional(z.string()),
  createdAt: z.string(),
  /** Where the image is served (same origin, session cookie). */
  url: z.string(),
});
export type Photo = z.infer<typeof PhotoSchema>;

/**
 * GET /api/photos?place=<placeId>: your photos of a place on your list, and
 * your friends' photos of it (only friends who share that spot), by friend id.
 */
export const PlacePhotosResponseSchema = z.strictObject({
  mine: z.array(PhotoSchema),
  friends: z.record(z.string(), z.array(PhotoSchema)),
  usage: z.strictObject({
    /** Bytes you've stored, all spots. */
    bytes: z.number(),
    maxBytes: z.number(),
    perSpot: z.number(),
  }),
});
export type PlacePhotosResponse = z.infer<typeof PlacePhotosResponseSchema>;

/** PATCH /api/photos/:id: set or clear (empty string) the caption. */
export const PhotoPatchSchema = z.strictObject({
  caption: z.string().check(z.maxLength(CAPTION_MAX, `${String(CAPTION_MAX)} characters at most`)),
});
export type PhotoPatch = z.infer<typeof PhotoPatchSchema>;
