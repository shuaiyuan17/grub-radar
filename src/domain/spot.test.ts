import { SEED_SPOTS } from '../data/seed';
import { parseSpots, type SpotInput } from './spot';

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
    ['rating on a want-to-try', { rating: 8 }],
    ['unknown field', { secret: 'nope' }],
    ['overlong note', { note: 'x'.repeat(61) }],
  ])('rejects %s', (_, patch) => {
    expect(() => parseSpots([{ ...valid, ...patch }])).toThrow(/Invalid spots data/);
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
