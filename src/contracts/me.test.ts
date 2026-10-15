import { AvatarEmojiSchema, DisplayNameSchema, PatchMeSchema } from './me';

describe('me contracts', () => {
  it.each(['🍜', '🥟', '🇯🇵', '👩‍🍳', '👍🏽', '❤️'])('%s is one emoji', (e) => {
    expect(AvatarEmojiSchema.safeParse(e).success).toBe(true);
  });

  it.each(['', 'a', '🍜🍜', 'ab', '1', ' '])('%j is not', (e) => {
    expect(AvatarEmojiSchema.safeParse(e).success).toBe(false);
  });

  it('trims names and caps them at 40', () => {
    expect(DisplayNameSchema.parse('  Tess  ')).toBe('Tess');
    expect(DisplayNameSchema.safeParse('x'.repeat(41)).success).toBe(false);
  });

  it('a patch must change something and nothing else', () => {
    expect(PatchMeSchema.safeParse({}).success).toBe(false);
    expect(PatchMeSchema.safeParse({ home: {} }).success).toBe(false);
    expect(PatchMeSchema.safeParse({ avatarEmoji: '🍩' }).success).toBe(true);
  });
});
