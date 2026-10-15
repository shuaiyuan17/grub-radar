import {
  AvatarEmojiSchema,
  clampName,
  DISPLAY_NAME_MAX_UNITS,
  DisplayNameSchema,
  PatchMeSchema,
} from './me';

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
    // 40 emoji are 40 graphemes even though they're 80 UTF-16 units
    expect(DisplayNameSchema.safeParse('🍜'.repeat(40)).success).toBe(true);
    // …but a long ZWJ sequence each is past the code-unit cap (see below)
    expect(DisplayNameSchema.safeParse('👩‍🍳'.repeat(40)).success).toBe(false);
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

describe('display names: nothing invisible, nothing huge', () => {
  it.each([
    ['zero-width space', 'Te\u200Bss'],
    ['zero-width non-joiner', 'Te\u200Css'],
    ['stray zero-width joiner', 'Te\u200Dss'],
    ['LRM / RLM', '\u200ETe\u200Fss'],
    ['word joiner', 'Te\u2060ss'],
    ['BOM', '\uFEFFTess'],
    ['line / paragraph separator', 'Te\u2028s\u2029s'],
    ['soft hyphen', 'Te\u00ADss'],
  ])('strips %s', (_, raw) => {
    expect(DisplayNameSchema.parse(raw)).toBe('Tess');
  });

  it.each([
    ['Hangul filler', '\u3164'],
    ['Hangul choseong / jungseong fillers', '\u115F\u1160'],
    ['zero-width only', '\u200B\u200B\u2060'],
    ['combining marks only', '\u0301\u0302'],
    ['spaces and fillers', ' \u3164 \uFFA0 '],
  ])('refuses a name that is only %s', (_, raw) => {
    expect(DisplayNameSchema.safeParse(raw).success).toBe(false);
  });

  it('keeps joiners inside emoji sequences', () => {
    expect(DisplayNameSchema.parse('Tess 👩‍🍳')).toBe('Tess 👩‍🍳');
  });

  it("Zalgo: 'a' + 5000 combining acutes is refused, and a small flood is cut to two marks", () => {
    expect(DisplayNameSchema.safeParse(`a${'\u0301'.repeat(5000)}`).success).toBe(false);
    expect(DisplayNameSchema.parse(`a${'\u0301'.repeat(30)}b`)).toBe(`a\u0301\u0301b`);
  });

  it(`caps code units at ${String(DISPLAY_NAME_MAX_UNITS)} even within 40 graphemes`, () => {
    // 40 graphemes, each a 7-unit family emoji: 280 units
    const big = '👨‍👩‍👧'.repeat(40);
    expect(big.length).toBeGreaterThan(DISPLAY_NAME_MAX_UNITS);
    expect(DisplayNameSchema.safeParse(big).success).toBe(false);
    expect(clampName(big).length).toBeLessThanOrEqual(DISPLAY_NAME_MAX_UNITS);
  });
});
