import { AvatarEmojiSchema, clampName, DisplayNameSchema, PatchMeSchema } from './me';

describe('me contracts', () => {
  it.each(['🍜', '🥟', '🇯🇵', '👩‍🍳', '👍🏽', '❤️'])('%s is one emoji', (e) => {
    expect(AvatarEmojiSchema.safeParse(e).success).toBe(true);
  });

  it.each(['', 'a', '🍜🍜', 'ab', '1', ' '])('%j is not', (e) => {
    expect(AvatarEmojiSchema.safeParse(e).success).toBe(false);
  });

  it('trims names and caps them at 40 graphemes', () => {
    expect(DisplayNameSchema.parse('  Tess  ')).toBe('Tess');
    expect(DisplayNameSchema.safeParse('x'.repeat(41)).success).toBe(false);
    // 40 emoji are 40 graphemes even though they're far more UTF-16 units
    expect(DisplayNameSchema.safeParse('👩‍🍳'.repeat(40)).success).toBe(true);
  });

  it('strips control and bidi characters from names', () => {
    expect(DisplayNameSchema.parse('Te\u202Ess\u0000')).toBe('Tess');
    expect(DisplayNameSchema.safeParse('\u2066\u200F').success).toBe(false);
  });

  it('clampName cuts on grapheme boundaries', () => {
    expect(clampName('ab👩‍🍳cd', 3)).toBe('ab👩‍🍳');
    expect(clampName('a𝒳b', 2)).toBe('a𝒳');
  });

  it('a patch must change something and nothing else', () => {
    expect(PatchMeSchema.safeParse({}).success).toBe(false);
    expect(PatchMeSchema.safeParse({ home: {} }).success).toBe(false);
    expect(PatchMeSchema.safeParse({ avatarEmoji: '🍩' }).success).toBe(true);
  });
});
