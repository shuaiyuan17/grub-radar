import { z } from 'zod/mini';

const graphemes = (s: string) => [...new Intl.Segmenter().segment(s)].length;

export const DisplayNameSchema = z
  .string()
  .check(z.trim(), z.minLength(1, 'name is empty'), z.maxLength(40, 'name is too long'));

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
