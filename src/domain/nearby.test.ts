import { StaticSpotRepository } from '../data/staticRepository';
import { findNearby } from './nearby';

const origin = { lat: 47.6101, lng: -122.3344 };
const spots = await new StaticSpotRepository().list();

describe('findNearby', () => {
  it('returns everything, closest first, with no limits', () => {
    const all = findNearby(spots, { origin });
    expect(all).toHaveLength(spots.length);
    const minutes = all.map((v) => v.travel.minutes);
    expect(minutes).toEqual([...minutes].sort((a, b) => a - b));
  });

  it('respects maxMinutes (inclusive)', () => {
    const near = findNearby(spots, { origin, maxMinutes: 10 });
    expect(near.length).toBeGreaterThan(0);
    expect(near.every((v) => v.travel.minutes <= 10)).toBe(true);
    expect(near.some((v) => v.travel.minutes === 10)).toBe(true);
  });

  it('filters by kind', () => {
    const coffee = findNearby(spots, { origin, kinds: ['coffee'] });
    expect(coffee.map((v) => v.spot.kind)).toEqual(coffee.map(() => 'coffee'));
    expect(findNearby(spots, { origin, kinds: [] })).toEqual([]);
  });

  it('measures from the given origin', () => {
    const farAway = { lat: 40.7128, lng: -74.006 };
    expect(findNearby(spots, { origin: farAway, maxMinutes: 60 })).toEqual([]);
  });
});
