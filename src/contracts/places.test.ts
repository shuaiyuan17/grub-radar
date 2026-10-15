import {
  AddApplePlaceSchema,
  AddByQuerySchema,
  addSpotForm,
  normalizeQuery,
  parsePlaceSearchQuery,
  roundForSearch,
} from './places';

const q = (s: string) => parsePlaceSearchQuery(new URLSearchParams(s));

describe('parsePlaceSearchQuery', () => {
  it('reads q (normalized), near and lang', () => {
    expect(q('q=%20Serious%20%20Pie%20&near=47.61,-122.33&lang=zh-Hans')).toEqual({
      q: 'serious pie',
      near: { lat: 47.61, lng: -122.33 },
      lang: 'zh-Hans',
    });
    expect(q('q=pho&near=home')).toEqual({ q: 'pho', near: 'home', lang: 'en' });
    expect(q('q=pho')).toEqual({ q: 'pho', lang: 'en' });
  });

  it.each([
    '',
    'q=a',
    'q=%20a%20',
    `q=${'x'.repeat(101)}`,
    'q=pho&near=',
    'q=pho&near=1',
    'q=pho&lang=fr',
  ])('%s is an error', (s) => {
    expect(q(s)).toHaveProperty('error');
  });

  it('two characters are enough (e.g. "汤包" or "bo")', () => {
    expect(q('q=%E6%B1%A4%E5%8C%85')).toMatchObject({ q: '汤包' });
  });
});

describe('normalizeQuery and roundForSearch', () => {
  it('folds case, width and spacing', () => {
    expect(normalizeQuery('  ＰＨＯ\t Bac ')).toBe('pho bac');
  });
  it('rounds to about a kilometre', () => {
    expect(roundForSearch({ lat: 47.618421, lng: -122.321937 })).toEqual({
      lat: 47.62,
      lng: -122.32,
    });
  });
});

describe('the Apple forms of add_spot', () => {
  it('addSpotForm picks the form by its key', () => {
    expect(addSpotForm({ applePlaceId: 'I1' })).toBe('apple');
    expect(addSpotForm({ query: 'pho' })).toBe('query');
    expect(addSpotForm({ name: 'x' })).toBe('manual');
    expect(addSpotForm(null)).toBe('manual');
  });

  it('an Apple place takes no name or location of its own', () => {
    expect(AddApplePlaceSchema.safeParse({ applePlaceId: 'I1', kind: 'coffee' }).success).toBe(
      true,
    );
    expect(AddApplePlaceSchema.safeParse({ applePlaceId: 'I1', name: 'x' }).success).toBe(false);
    expect(
      AddApplePlaceSchema.safeParse({ applePlaceId: 'I1', location: { lat: 0, lng: 0 } }).success,
    ).toBe(false);
    expect(AddApplePlaceSchema.safeParse({ applePlaceId: 'I1', rating: 9 }).success).toBe(false);
    expect(
      AddApplePlaceSchema.safeParse({ applePlaceId: 'I1', status: 'been', rating: 9 }).success,
    ).toBe(true);
  });

  it('a query may say where to look', () => {
    expect(AddByQuerySchema.parse({ query: ' pho ', near: 'home' })).toEqual({
      query: 'pho',
      near: 'home',
    });
    expect(AddByQuerySchema.safeParse({ query: 'pho', near: { lat: 1, lng: 2 } }).success).toBe(
      true,
    );
  });
});
