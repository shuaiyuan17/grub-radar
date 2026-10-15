import { z } from 'zod/mini';

const segmenter = new Intl.Segmenter();
const graphemes = (s: string) => [...segmenter.segment(s)].length;

export const DISPLAY_NAME_MAX = 40;

// control characters and the bidi overrides/isolates/marks that can make a
// name render as something else ("Trojan Source" style)
const UNSAFE_CHARS = /[\p{Cc}\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu;

/** Strip control and bidi characters, trim. */
export const sanitizeName = (s: string) => s.replace(UNSAFE_CHARS, '').trim();

/** Sanitize, then cut to at most `max` whole graphemes (never half an emoji or surrogate pair). */
export function clampName(s: string, max = DISPLAY_NAME_MAX): string {
  const parts = [...segmenter.segment(sanitizeName(s))].slice(0, max);
  return parts
    .map((p) => p.segment)
    .join('')
    .trim();
}

export const DisplayNameSchema = z.string().check(
  z.overwrite(sanitizeName),
  z.minLength(1, 'name is empty'),
  z.refine((s) => graphemes(s) <= DISPLAY_NAME_MAX, { message: 'name is too long' }),
);

/** One emoji (one grapheme cluster, so flags and ZWJ sequences count as one). */
export const AvatarEmojiSchema = z.string().check(
  z.trim(),
  z.minLength(1),
  z.maxLength(32),
  z.refine(
    (s) => graphemes(s) === 1 && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s),
    {
      message: 'avatar must be a single emoji',
    },
  ),
);

export const MeUserSchema = z.strictObject({
  id: z.string(),
  displayName: z.string(),
  avatarEmoji: z.string(),
});
export type MeUser = z.infer<typeof MeUserSchema>;

/** GET /api/me. `home` is private: only ever returned here, to the owner's own session. */
export const MeResponseSchema = z.strictObject({
  user: MeUserSchema,
  home: z.nullable(z.strictObject({ lat: z.number(), lng: z.number() })),
  signupOpen: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** PATCH /api/me body. Returns the updated `MeUser`. */
export const PatchMeSchema = z
  .strictObject({
    displayName: z.optional(DisplayNameSchema),
    avatarEmoji: z.optional(AvatarEmojiSchema),
  })
  .check(
    z.refine((p) => p.displayName !== undefined || p.avatarEmoji !== undefined, {
      message: 'nothing to change',
    }),
  );
export type PatchMe = z.infer<typeof PatchMeSchema>;
