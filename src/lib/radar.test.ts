import { StaticSpotRepository } from '../data/staticRepository';
import { byTravelTime, toSpotViews } from '../domain/spotView';
import {
  DOT_TARGET_PX,
  hubPx,
  LABEL_PX,
  layoutRadar,
  MARK_CLEAR_PX,
  PHONE_RADAR_PX,
  radiusFor,
  RING_DIAMETERS,
  type RadarPoint,
} from './radar';

const DEMO_HOME = { lat: 47.6101, lng: -122.3344 };
const seedInputs = toSpotViews(new StaticSpotRepository().snapshot(), DEMO_HOME)
  .sort(byTravelTime)
  .map((v) => ({ id: v.spot.id, minutes: v.travel.minutes, ring: v.ring, bearing: v.bearing }));

/** Asserts no two hit targets overlap and no visible mark covers the hub or a ring label. */
function expectNoOverlap(points: RadarPoint[], size: number, target: number) {
  const px = points.map((p) => ({ id: p.id, x: p.x * size, y: p.y * size }));
  for (let i = 0; i < px.length; i++) {
    const a = px[i]!;
    for (let j = 0; j < i; j++) {
      const b = px[j]!;
      expect(Math.hypot(a.x - b.x, a.y - b.y), `${a.id} vs ${b.id}`).toBeGreaterThanOrEqual(
        target - 1e-6,
      );
    }
    const c = size / 2;
    expect(Math.hypot(a.x - c, a.y - c), `${a.id} vs hub`).toBeGreaterThanOrEqual(
      hubPx(size) / 2 + MARK_CLEAR_PX / 2 - 1e-6,
    );
    for (const d of RING_DIAMETERS) {
      const ly = c - (d * size) / 2;
      const under =
        Math.abs(a.x - c) < LABEL_PX.w / 2 + MARK_CLEAR_PX / 2 - 1e-6 &&
        Math.abs(a.y - ly) < LABEL_PX.h / 2 + MARK_CLEAR_PX / 2 - 1e-6;
      expect(under, `${a.id} under the ${d} label`).toBe(false);
    }
  }
}

describe('radiusFor', () => {
  it('keeps each ring inside its own ring line', () => {
    expect(radiusFor(10, 0)).toBeLessThan(RING_DIAMETERS[0] / 2);
    expect(radiusFor(11, 1)).toBeGreaterThan(RING_DIAMETERS[0] / 2);
    expect(radiusFor(30, 1)).toBeLessThan(RING_DIAMETERS[1] / 2);
    expect(radiusFor(45, 2)).toBeGreaterThan(RING_DIAMETERS[1] / 2);
    expect(radiusFor(60, 2)).toBeLessThan(RING_DIAMETERS[2] / 2);
    expect(radiusFor(500, 3)).toBeLessThan(RING_DIAMETERS[3] / 2);
  });

  it('grows with time', () => {
    expect(radiusFor(5, 0)).toBeLessThan(radiusFor(9, 0));
    expect(radiusFor(15, 1)).toBeLessThan(radiusFor(25, 1));
  });
});

describe('layoutRadar', () => {
  it('puts north up and east right', () => {
    const [n, e] = layoutRadar([
      { id: 'n', minutes: 45, ring: 2, bearing: 30 },
      { id: 'e', minutes: 20, ring: 1, bearing: 90 },
    ]);
    expect(n!.x).toBeGreaterThan(0.5);
    expect(n!.y).toBeLessThan(0.5);
    expect(e!.x).toBeGreaterThan(0.5);
    expect(e!.y).toBeCloseTo(0.5, 6);
  });

  it('seed data: no overlapping 40px tap targets on a 390px phone', () => {
    expectNoOverlap(layoutRadar(seedInputs), PHONE_RADAR_PX, DOT_TARGET_PX);
  });

  it('seed data: no overlap on the desktop radar either', () => {
    expectNoOverlap(layoutRadar(seedInputs, { size: 600 }), 600, DOT_TARGET_PX);
  });

  it('spreads a pile of dots in the same spot', () => {
    const pile = Array.from({ length: 5 }, (_, i) => ({
      id: String(i),
      minutes: 20,
      ring: 1 as const,
      bearing: 120,
    }));
    expectNoOverlap(layoutRadar(pile), PHONE_RADAR_PX, DOT_TARGET_PX);
  });

  it('keeps every dot inside its ring band', () => {
    const pts = layoutRadar(seedInputs);
    seedInputs.forEach((input, i) => {
      const p = pts[i]!;
      const r = Math.hypot(p.x - 0.5, p.y - 0.5);
      const inner = input.ring === 0 ? 0 : RING_DIAMETERS[input.ring - 1]! / 2;
      expect(r).toBeGreaterThan(inner);
      expect(r).toBeLessThan(RING_DIAMETERS[input.ring] / 2);
    });
  });
});
