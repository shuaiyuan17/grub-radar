import { clampRadii, hashSeed, parseCorner, wobblyPath, WOBBLE_PX, type Radii } from './inkPath';

const r = (x: number, y = x) => ({ x, y });
const square: Radii = [r(0), r(0), r(0), r(0)];

function points(d: string) {
  return [...d.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((m) => ({
    x: Number(m[1]),
    y: Number(m[2]),
  }));
}

describe('wobblyPath', () => {
  it('is a closed path', () => {
    const d = wobblyPath(200, 80, [r(18), r(24), r(16), r(22)], 1);
    expect(d.startsWith('M')).toBe(true);
    expect(d.endsWith('Z')).toBe(true);
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = wobblyPath(200, 80, square, 1);
    expect(wobblyPath(200, 80, square, 1)).toBe(a);
    expect(wobblyPath(200, 80, square, 2)).not.toBe(a);
  });

  it('wobbles within the amplitude around the box', () => {
    for (const p of points(wobblyPath(300, 120, square, 7))) {
      expect(p.x).toBeGreaterThanOrEqual(-WOBBLE_PX - 0.1);
      expect(p.x).toBeLessThanOrEqual(300 + WOBBLE_PX + 0.1);
      expect(p.y).toBeGreaterThanOrEqual(-WOBBLE_PX - 0.1);
      expect(p.y).toBeLessThanOrEqual(120 + WOBBLE_PX + 0.1);
    }
  });

  it('respects the inset (half the stroke width)', () => {
    for (const p of points(wobblyPath(100, 100, square, 3, 5))) {
      expect(p.x).toBeGreaterThanOrEqual(5 - WOBBLE_PX - 0.1);
    }
  });

  it('draws nothing for an empty box', () => {
    expect(wobblyPath(0, 40, square, 1)).toBe('');
  });

  it('scales with the box: wider box, more points', () => {
    expect(points(wobblyPath(600, 80, square, 1)).length).toBeGreaterThan(
      points(wobblyPath(200, 80, square, 1)).length,
    );
  });
});

describe('clampRadii', () => {
  it('scales radii down like CSS when they overlap', () => {
    const [tl, tr] = clampRadii(100, 40, [r(999), r(999), r(999), r(999)]);
    expect(tl.y + clampRadii(100, 40, [r(999), r(999), r(999), r(999)])[3].y).toBeCloseTo(40, 6);
    expect(tl.x).toBeCloseTo(tr.x, 6);
  });
  it('leaves small radii alone', () => {
    expect(clampRadii(100, 100, [r(10), r(12), r(14), r(16)])[1]).toEqual(r(12));
  });
});

describe('parseCorner', () => {
  it.each([
    ['18px 22px', 200, 100, { x: 18, y: 22 }],
    ['10px', 200, 100, { x: 10, y: 10 }],
    ['50%', 200, 100, { x: 100, y: 50 }],
    ['50% 46%', 100, 100, { x: 50, y: 46 }],
    ['0px', 50, 50, { x: 0, y: 0 }],
  ])('%s', (value, w, h, expected) => {
    expect(parseCorner(value, w, h)).toEqual(expected);
  });
});

it('hashSeed is stable', () => {
  expect(hashSeed(':r1:')).toBe(hashSeed(':r1:'));
  expect(hashSeed(':r1:')).not.toBe(hashSeed(':r2:'));
});
