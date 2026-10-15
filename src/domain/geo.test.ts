import { bearingDeg, distanceKm, isLatLng, kmToMiles, parseLatLng } from './geo';

describe('distanceKm', () => {
  it('is zero for the same point', () => {
    expect(distanceKm({ lat: 47.6, lng: -122.3 }, { lat: 47.6, lng: -122.3 })).toBe(0);
  });

  it('matches a known distance (Seattle to Portland, ~234 km)', () => {
    const seattle = { lat: 47.6062, lng: -122.3321 };
    const portland = { lat: 45.5152, lng: -122.6784 };
    expect(distanceKm(seattle, portland)).toBeCloseTo(234, -1);
  });

  it('is symmetric', () => {
    const a = { lat: 10, lng: 20 };
    const b = { lat: -5, lng: 33 };
    expect(distanceKm(a, b)).toBeCloseTo(distanceKm(b, a), 9);
  });

  it('one degree of latitude is ~111 km', () => {
    expect(distanceKm({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })).toBeCloseTo(111.2, 0);
  });
});

describe('bearingDeg', () => {
  const o = { lat: 47.6, lng: -122.3 };
  it.each([
    ['north', { lat: 47.7, lng: -122.3 }, 0],
    ['east', { lat: 47.6, lng: -122.2 }, 90],
    ['south', { lat: 47.5, lng: -122.3 }, 180],
    ['west', { lat: 47.6, lng: -122.4 }, 270],
  ])('points %s', (_, to, expected) => {
    expect(bearingDeg(o, to)).toBeCloseTo(expected, 0);
  });
});

it('converts km to miles', () => {
  expect(kmToMiles(1.609344)).toBeCloseTo(1, 9);
});

describe('parseLatLng', () => {
  it.each([
    ['47.61,-122.33', { lat: 47.61, lng: -122.33 }],
    [' 47.61 , -122.33 ', { lat: 47.61, lng: -122.33 }],
    ['47.61 -122.33', { lat: 47.61, lng: -122.33 }],
    ['-90,180', { lat: -90, lng: 180 }],
    ['+1.5,.25', { lat: 1.5, lng: 0.25 }],
  ])('parses %j', (raw, expected) => {
    expect(parseLatLng(raw)).toEqual(expected);
  });

  it.each([
    '',
    '   ',
    '47.61,', // Number('') is 0: must not become lng 0
    ',-122.33',
    '47.61',
    '47.61,-122.33,5',
    '91,0',
    '0,181',
    'abc,def',
    '1e3,2',
    'Infinity,0',
    'NaN,0',
    '0x10,0',
  ])('rejects %j', (raw) => {
    expect(parseLatLng(raw)).toBeNull();
  });
});

describe('isLatLng', () => {
  it('accepts real coordinates', () => {
    expect(isLatLng({ lat: 47.6, lng: -122.3 })).toBe(true);
  });
  it.each([
    null,
    undefined,
    'x',
    {},
    { lat: '47', lng: 1 },
    { lat: NaN, lng: 0 },
    { lat: 0, lng: 200 },
  ])('rejects %j', (v) => {
    expect(isLatLng(v)).toBe(false);
  });
});
