import { SEED_SPOTS } from '../data/seed';
import {
  compareVerdicts,
  comparePrices,
  dataLang,
  parseSpots,
  type Price,
  type SpotInput,
  type Verdict,
} from './spot';

const valid: SpotInput = {
  id: 'test-spot',
  name: 'Test Spot',
  kind: 'food',
  cuisine: 'tests',
  price: '$',
  tags: ['Noodles'],
  status: 'want',
  note: 'a note',
  order: [],
  icon: 'bowl',
  location: { lat: 47.6, lng: -122.3 },
};

describe('spot schema', () => {
  it('accepts a minimal spot and lowercases tags', () => {
    expect(parseSpots([valid])[0]?.tags).toEqual(['noodles']);
  });

  it.each<[string, Record<string, unknown>]>([
    ['bad id', { id: 'Not A Slug' }],
    ['unknown kind', { kind: 'bar' }],
    ['latitude out of range', { location: { lat: 91, lng: 0 } }],
    ['bad date', { why: { text: 'x', foundOn: 'yesterday' } }],
    ['verdict on a want-to-try', { verdict: 'good' }],
    ['a 1-10 score instead of a verdict', { status: 'been', verdict: 8 }],
    ['the old rating field', { status: 'been', rating: 8 }],
    ['an unknown verdict', { status: 'been', verdict: 'great' }],
    ['unknown field', { secret: 'nope' }],
    ['overlong note', { note: 'x'.repeat(61) }],
    ['free-text hours', { hours: { closes: '10pm' } }],
    ['25 oclock', { hours: { closes: '25:00' } }],
    ['unknown day', { hours: { closes: '22:00', days: ['someday'] } }],
    ['empty days', { hours: { closes: '22:00', days: [] } }],
    ['old openTill field', { openTill: '10pm' }],
    ['unknown data lang', { lang: 'fr' }],
  ])('rejects %s', (_, patch) => {
    expect(() => parseSpots([{ ...valid, ...patch }])).toThrow(/Invalid spots data/);
  });

  it('accepts structured hours and a data language', () => {
    const [spot] = parseSpots([
      { ...valid, hours: { closes: 'sold-out', days: ['sat'] }, lang: 'zh-Hans' },
    ]);
    expect(spot?.hours).toEqual({ closes: 'sold-out', days: ['sat'] });
    expect(dataLang(spot!)).toBe('zh-Hans');
    expect(dataLang(valid)).toBe('en');
  });

  it('rejects duplicate ids', () => {
    expect(() => parseSpots([valid, valid])).toThrow(/duplicate id "test-spot"/);
  });
});

describe('seed data', () => {
  const spots = parseSpots(SEED_SPOTS);

  it('is valid', () => {
    expect(spots.length).toBeGreaterThanOrEqual(10);
  });

  it('has every kind', () => {
    expect(new Set(spots.map((s) => s.kind))).toEqual(new Set(['food', 'coffee', 'bakery']));
  });

  it('stays in the demo area around Seattle (public repo: demo data only)', () => {
    for (const s of spots) {
      expect(Math.abs(s.location.lat - 47.6)).toBeLessThan(1);
      expect(Math.abs(s.location.lng + 122.3)).toBeLessThan(1.5);
    }
  });
});

describe('unknown price, verdicts', () => {
  it('price is optional: absent means unknown; no price is invented on the way through', () => {
    const [parsed] = parseSpots([{ ...valid, price: undefined }]);
    expect(parsed?.price).toBeUndefined();
  });

  it('verdicts sort best first, and no verdict last', () => {
    const vs: (Verdict | undefined)[] = [undefined, 'bad', 'good', undefined, 'meh'];
    expect(vs.sort(compareVerdicts)).toEqual(['good', 'meh', 'bad', undefined, undefined]);
  });

  it('prices sort cheapest first, and an unknown price last (not as cheap)', () => {
    const ps: (Price | undefined)[] = ['$$$', undefined, '$', '$$$$', '$$'];
    expect(ps.sort(comparePrices)).toEqual(['$', '$$', '$$$', '$$$$', undefined]);
  });
});
