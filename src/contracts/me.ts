import { z } from 'zod/mini';

const segmenter = new Intl.Segmenter();
const graphemes = (s: string) => [...segmenter.segment(s)].length;

export const DISPLAY_NAME_MAX = 40;
/** …and at most this many UTF-16 code units, whatever the graphemes (combining-mark floods). */
export const DISPLAY_NAME_MAX_UNITS = 160;
/** The name an account gets when Apple doesn't send one (it only does on the first sign-in). */
export const DEFAULT_DISPLAY_NAME = 'you';

// Characters that are invisible or make a name render as something else:
//  - control characters, and the bidi overrides/isolates/marks ("Trojan Source")
//  - zero-width space / non-joiner, word joiner + invisible operators, BOM, soft hyphen,
//    combining grapheme joiner, Mongolian vowel separator
//  - Hangul fillers (blank letters: U+115F, U+1160, U+3164, U+FFA0)
//  - line and paragraph separators
const UNSAFE_CHARS =
  /\u034F|[\p{Cc}\u00AD\u061C\u115F\u1160\u180E\u200B\u200C\u200E\u200F\u2028-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]/gu;
// A zero-width joiner survives only inside an emoji sequence (👩‍🍳); anywhere else it's invisible.
const STRAY_ZWJ =
  /(?<![\p{Extended_Pictographic}\uFE0F\p{Emoji_Modifier}])\u200D|\u200D(?!\p{Extended_Pictographic})/gu;
// More than two combining marks on one letter is a "Zalgo" flood: keep the first two.
const MARK_FLOOD = /(\p{M}{2})\p{M}+/gu;
/** Something you can see: not a space, mark, control, format or private-use character. */
const VISIBLE = /[^\p{Z}\p{M}\p{C}]/u;

/** Strip invisible and bidi characters, cut mark floods, trim. */
export const sanitizeName = (s: string) =>
  s.replace(UNSAFE_CHARS, '').replace(STRAY_ZWJ, '').replace(MARK_FLOOD, '$1').trim();

/** Sanitize, then cut to at most `max` whole graphemes (never half an emoji or surrogate pair). */
export function clampName(s: string, max = DISPLAY_NAME_MAX): string {
  const parts = [...segmenter.segment(sanitizeName(s))].slice(0, max);
  let out = '';
  for (const p of parts) {
    if (out.length + p.segment.length > DISPLAY_NAME_MAX_UNITS) break;
    out += p.segment;
  }
  return out.trim();
}

export const DisplayNameSchema = z.string().check(
  // a hard cap before any work: a huge string never reaches the regexes
  z.maxLength(DISPLAY_NAME_MAX_UNITS * 8, 'name is too long'),
  z.overwrite(sanitizeName),
  z.minLength(1, 'name is empty'),
  z.refine((s) => VISIBLE.test(s), { message: 'name is empty' }),
  z.refine((s) => graphemes(s) <= DISPLAY_NAME_MAX && s.length <= DISPLAY_NAME_MAX_UNITS, {
    message: 'name is too long',
  }),
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
  /** Your own name. While `nameSet` is false it's the stand-in DEFAULT_DISPLAY_NAME. */
  displayName: z.string(),
  avatarEmoji: z.string(),
  /**
   * Have you chosen your name (Apple sent it at sign-up, or you saved one)?
   * false: the app asks before anything else, and nobody else sees a name for
   * you (friends see a placeholder instead).
   */
  nameSet: z.boolean(),
});
export type MeUser = z.infer<typeof MeUserSchema>;

/** GET /api/me. `home` is private: only ever returned here, to the owner's own session. */
export const MeResponseSchema = z.strictObject({
  user: MeUserSchema,
  home: z.nullable(z.strictObject({ lat: z.number(), lng: z.number() })),
  signupOpen: z.boolean(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/** PATCH /api/me body. Returns the updated `MeUser`. Saving a `displayName` sets `nameSet`. */
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
