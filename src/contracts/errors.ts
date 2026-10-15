import { z } from 'zod/mini';

/**
 * Machine-readable error codes. The SPA maps codes to (localised) copy; the
 * `message` is for humans reading curl output and logs.
 */
export const ERROR_CODES = [
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'csrf',
  'internal',
  /** The spot changed under you (two writes at once); fetch it and try again. */
  'conflict',
  /** Your notes for one spot are full (LIMITS.myNote). */
  'note_too_long',
  /** A verdict (good/meh/bad) on a spot you haven't been to. */
  'verdict_needs_been',
  /** The place itself (name, location, …) isn't yours to edit. */
  'not_editable',
  /** origin=home, but no home is saved. */
  'no_home',
  /** A visit or note dated in the future. */
  'future_date',
  /** The list already holds LIMITS.spots spots. */
  'list_full',
  /** Apple Maps didn't answer (down, slow, out of daily quota). Try again later. */
  'maps_unavailable',
  /** An Apple Maps search (add_spot with `query`) found nothing to add. */
  'no_match',
  /** add_spot with `query` found several plausible places; nothing was added. Pick one. */
  'ambiguous',
  /** add_spot with `query` needs `near`, or a saved home, to search around. */
  'need_location',
  /**
   * An invite link that can't be used: unknown, already used, revoked or
   * expired (deliberately one code: which one is nobody's business).
   */
  'invite_gone',
  /** That's your own invite link: send it to someone else. */
  'own_invite',
  /** You (or the person who invited you) already have the most friends allowed. */
  'friend_limit',
  /** You've made the most invite links allowed for one day. */
  'invite_limit',
  /** A photo that isn't a WebP or JPEG we can read (wrong type, broken, too many pixels). */
  'bad_image',
  /** A photo that still carries EXIF or XMP (which can hold where it was taken). */
  'image_metadata',
  /** A photo over PHOTO_MAX_BYTES. */
  'photo_too_big',
  /** This spot already has PHOTOS_PER_SPOT photos of yours. */
  'photo_limit',
  /** Your photos already fill PHOTO_STORAGE_BYTES. */
  'storage_full',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ApiErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(ERROR_CODES), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Why the sign-in round trip came back without a session, as `/?signin=…`.
 * cancelled: the person backed out on Apple's page. closed: sign-up is
 * invite-only and this Apple ID has no account. failed: anything else.
 */
export const SIGNIN_RESULTS = ['cancelled', 'closed', 'failed'] as const;
export type SigninResult = (typeof SIGNIN_RESULTS)[number];

/** Header every cookie-authenticated write must carry (CSRF defence, see worker/auth/csrf.ts). */
export const CSRF_HEADER = 'X-Grub-Request';
