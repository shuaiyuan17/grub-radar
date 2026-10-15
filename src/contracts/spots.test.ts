import { parseNearbyQuery, RollBodySchema } from './spots';

const q = (s: string) => parseNearbyQuery(new URLSearchParams(s));

describe('parseNearbyQuery', () => {
  it('defaults to home and 10 results', () => {
    expect(q('')).toEqual({ origin: 'home', limit: 10 });
  });

  it('reads coordinates, minutes, kinds and limit', () => {
    expect(q('origin=47.61,-122.33&maxMinutes=30&kinds=food,coffee,food&limit=5')).toEqual({
      origin: { lat: 47.61, lng: -122.33 },
      maxMinutes: 30,
      kinds: ['food', 'coffee'],
      limit: 5,
    });
  });

  it.each([
    'origin=x',
    'origin=91,0',
    'maxMinutes=-1',
    'maxMinutes=',
    'kinds=',
    'kinds=bar',
    'limit=51',
    'limit=1.5',
  ])('%s is an error', (s) => {
    expect(q(s)).toHaveProperty('error');
  });
});

describe('RollBodySchema', () => {
  it('takes home or coordinates', () => {
    expect(RollBodySchema.safeParse({ origin: 'home' }).success).toBe(true);
    expect(
      RollBodySchema.safeParse({ origin: { lat: 1, lng: 2 }, kinds: ['coffee'] }).success,
    ).toBe(true);
    expect(RollBodySchema.safeParse({ origin: 'work' }).success).toBe(false);
    expect(RollBodySchema.safeParse({ origin: 'home', extra: 1 }).success).toBe(false);
  });
});
