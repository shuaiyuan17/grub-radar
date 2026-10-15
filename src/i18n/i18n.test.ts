import { HEADLINE_COPY } from '../copy/headlines';
import { StaticSpotRepository } from '../data/staticRepository';
import { parseHeadline } from '../domain/headlines';
import { detectLocale, isLocale, LOCALES } from './locales';
import { MESSAGES, type Messages } from './messages';

const en = MESSAGES.en;
const zh = MESSAGES['zh-Hans'];

/** Every leaf path of a catalog, with the leaf's runtime type. */
function shape(value: unknown, path = ''): string[] {
  if (typeof value === 'function') return [`${path}:function`];
  if (Array.isArray(value)) return [`${path}:array(${value.length})`];
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => shape(v, path ? `${path}.${k}` : k));
  }
  return [`${path}:${typeof value}`];
}

describe('message catalog', () => {
  it('zh has exactly the same keys and kinds of value as en', () => {
    // (the type system already enforces this; this guards against casts)
    const enShape = shape({ ...en, tags: {} }).sort();
    const zhShape = shape({ ...zh, tags: {} }).sort();
    expect(zhShape).toEqual(enShape);
  });

  it.each(LOCALES)('%s has no empty strings', (locale) => {
    const strings = JSON.stringify(MESSAGES[locale], (_, v: unknown) =>
      typeof v === 'function' ? undefined : v,
    );
    expect(strings).not.toMatch(/""/);
  });

  it.each(LOCALES)('%s highlight strings each mark exactly one phrase', (locale) => {
    const m: Messages = MESSAGES[locale];
    for (const line of [
      ...Object.values(m.modeHeadlines),
      m.radarHeadline,
      m.spotNotFound,
      m.pageNotFound,
    ]) {
      expect(() => parseHeadline(line)).not.toThrow();
    }
  });

  it('zh actually is Chinese (not a copy of en)', () => {
    expect(zh.modes.near).not.toBe(en.modes.near);
    expect(zh.travelMode).toEqual({ walk: '步行', drive: '开车' });
    expect(zh.minutes(8)).toBe('8 分钟');
    expect(zh.minutes(70)).toBe('1 小时 10 分');
    expect(zh.minutes(60)).toBe('1 小时');
    expect(zh.distance(0.49, 0.3)).toBe('0.5 公里');
    expect(zh.ringLabels).toEqual(['10 分钟', '30 分钟', '1 小时', '自驾游']);
    expect(zh.formatDate('2026-09-12')).toBe('2026年9月12日');
  });

  it('en keeps its formats', () => {
    expect(en.minutes(70)).toBe('1h 10');
    expect(en.distance(0.49, 0.3)).toBe('0.3 mi');
    expect(en.formatDate('2026-09-12')).toBe('sep 12, 2026');
  });

  it('zh has a label for every craving tag in the seed data', () => {
    const tags = new Set(new StaticSpotRepository().snapshot().flatMap((s) => s.tags));
    const missing = [...tags].filter((t) => !(t in zh.tags));
    expect(missing).toEqual([]);
  });

  it('headline copy exists for every locale', () => {
    expect(Object.keys(HEADLINE_COPY).sort()).toEqual([...LOCALES].sort());
  });
});

describe('detectLocale', () => {
  it.each([
    [['zh-CN'], 'zh-Hans'],
    [['zh-Hans-CN', 'en'], 'zh-Hans'],
    [['zh-TW'], 'zh-Hans'],
    [['ZH'], 'zh-Hans'],
    [['en-US', 'zh-CN'], 'en'],
    [['fr-FR', 'zh-CN'], 'zh-Hans'],
    [['fr-FR'], 'en'],
    [[], 'en'],
  ])('%j -> %s', (langs, expected) => {
    expect(detectLocale(langs)).toBe(expected);
  });

  it('knows its locales', () => {
    expect(isLocale('zh-Hans')).toBe(true);
    expect(isLocale('zh')).toBe(false);
  });
});

describe('opening hours', () => {
  it.each([
    [{ closes: '22:00' }, '10pm', '22:00'],
    [{ closes: '22:30' }, '10:30pm', '22:30'],
    [{ closes: '00:00' }, 'midnight', '午夜'],
    [{ closes: '12:00' }, 'noon', '12:00'],
    [{ closes: '09:15' }, '9:15am', '09:15'],
    [{ closes: '23:00', days: ['fri' as const] }, '11pm (fri)', '23:00（周五）'],
    [
      { closes: '23:00', days: ['fri' as const, 'sat' as const] },
      '11pm (fri, sat)',
      '23:00（周五、周六）',
    ],
    [{ closes: 'sold-out' as const }, 'sold out', '卖完为止'],
  ])('%j -> en %s / zh %s', (hours, enText, zhText) => {
    expect(en.hours(hours)).toBe(enText);
    expect(zh.hours(hours)).toBe(zhText);
  });
});
