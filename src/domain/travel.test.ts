import {
  chooseMode,
  CITY_KM,
  DETOUR_FACTOR,
  DRIVE_OVERHEAD_MINUTES,
  driveMinutes,
  estimateFromKm,
  estimateTravel,
  formatMiles,
  formatMinutes,
  maxMinutesForRing,
  MAX_WALK_MINUTES,
  ringFor,
  WALK_KMH,
  walkMinutes,
} from './travel';

/** Crow-flies km at which walking takes exactly the max walk time. */
const walkLimitKm = ((MAX_WALK_MINUTES / 60) * WALK_KMH) / DETOUR_FACTOR;

describe('travel-time heuristic', () => {
  it('walks short hops', () => {
    const e = estimateFromKm(0.49);
    expect(e.mode).toBe('walk');
    expect(e.minutes).toBe(8);
  });

  it('walks right up to the walk limit, drives just past it', () => {
    expect(estimateFromKm(walkLimitKm - 0.001).mode).toBe('walk');
    expect(estimateFromKm(walkLimitKm + 0.001).mode).toBe('drive');
  });

  it('walks at exactly the limit (inclusive), drives a hair over it', () => {
    expect(chooseMode(MAX_WALK_MINUTES)).toBe('walk');
    expect(chooseMode(MAX_WALK_MINUTES + 1e-9)).toBe('drive');
    expect(chooseMode(0)).toBe('walk');
  });

  it('never estimates less than a minute, even at zero distance', () => {
    expect(estimateFromKm(0)).toMatchObject({ mode: 'walk', minutes: 1 });
  });

  it('treats negative input as zero', () => {
    expect(estimateFromKm(-3).km).toBe(0);
  });

  it('adds the driving overhead', () => {
    expect(driveMinutes(0)).toBe(DRIVE_OVERHEAD_MINUTES);
  });

  it('drives city streets at 2 min/km of street, then highway at 0.75 min/km', () => {
    const cityCrowKm = CITY_KM / DETOUR_FACTOR;
    expect(driveMinutes(cityCrowKm)).toBeCloseTo(DRIVE_OVERHEAD_MINUTES + 16, 6);
    const tenMoreStreetKm = (CITY_KM + 10) / DETOUR_FACTOR;
    expect(driveMinutes(tenMoreStreetKm)).toBeCloseTo(DRIVE_OVERHEAD_MINUTES + 16 + 7.5, 6);
  });

  it('gives sensible times for the demo distances', () => {
    expect(estimateFromKm(1.6)).toMatchObject({ mode: 'drive', minutes: 8 });
    expect(estimateFromKm(11.3)).toMatchObject({ mode: 'drive', minutes: 25 });
    expect(estimateFromKm(57.4)).toMatchObject({ mode: 'drive', minutes: 70 });
  });

  it('is monotonic: further never means faster', () => {
    let last = 0;
    for (let km = 0; km < 200; km += 0.25) {
      const m = estimateFromKm(km).minutes;
      // switching walk -> drive may drop the time; within a mode it never does
      if (km > walkLimitKm + 0.25) expect(m).toBeGreaterThanOrEqual(last);
      last = m;
    }
  });

  it('walking speed constant drives walk minutes', () => {
    expect(walkMinutes(WALK_KMH / DETOUR_FACTOR)).toBeCloseTo(60, 6);
  });

  it('estimates between two points', () => {
    const e = estimateTravel({ lat: 47.6101, lng: -122.3344 }, { lat: 47.6135, lng: -122.3302 });
    expect(e.mode).toBe('walk');
    expect(e.miles).toBeCloseTo(e.km / 1.609344, 9);
  });
});

describe('rings', () => {
  it.each([
    [1, 0],
    [10, 0],
    [11, 1],
    [30, 1],
    [31, 2],
    [60, 2],
    [61, 3],
    [400, 3],
  ])('%i min is ring %i', (minutes, ring) => {
    expect(ringFor(minutes)).toBe(ring);
  });

  it('maps rings to max minutes', () => {
    expect([0, 1, 2, 3].map((r) => maxMinutesForRing(r as 0 | 1 | 2 | 3))).toEqual([
      10,
      30,
      60,
      Infinity,
    ]);
  });
});

describe('formatting', () => {
  it.each([
    [0, '1 min'],
    [8, '8 min'],
    [59, '59 min'],
    [60, '1h'],
    [70, '1h 10'],
    [95, '1h 35'],
    [125, '2h 05'],
  ])('%i minutes -> %s', (m, s) => {
    expect(formatMinutes(m)).toBe(s);
  });

  it.each([
    [0.31, '0.3 mi'],
    [7, '7.0 mi'],
    [35.7, '36 mi'],
  ])('%f miles -> %s', (mi, s) => {
    expect(formatMiles(mi)).toBe(s);
  });
});
