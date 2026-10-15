import { layoutRadar, LABEL_BOXES, MIN_GAP, radiusFor, RING_DIAMETERS } from './radar';

describe('radiusFor', () => {
  it('keeps each ring inside its own band', () => {
    expect(radiusFor(1, 0)).toBeLessThan(RING_DIAMETERS[0]);
    expect(radiusFor(10, 0)).toBeLessThan(RING_DIAMETERS[0]);
    expect(radiusFor(11, 1)).toBeGreaterThan(RING_DIAMETERS[0]);
    expect(radiusFor(30, 1)).toBeLessThan(RING_DIAMETERS[1]);
    expect(radiusFor(45, 2)).toBeGreaterThan(RING_DIAMETERS[1]);
    expect(radiusFor(60, 2)).toBeLessThan(RING_DIAMETERS[2]);
    expect(radiusFor(500, 3)).toBeLessThan(RING_DIAMETERS[3]);
  });

  it('grows with time', () => {
    expect(radiusFor(5, 0)).toBeLessThan(radiusFor(9, 0));
    expect(radiusFor(15, 1)).toBeLessThan(radiusFor(25, 1));
  });
});

describe('layoutRadar', () => {
  it('puts north up and east right', () => {
    const [n, e] = layoutRadar([
      { id: 'n', minutes: 20, ring: 1, bearing: 0 },
      { id: 'e', minutes: 20, ring: 1, bearing: 90 },
    ]);
    expect(n!.x).toBeCloseTo(0.5, 6);
    expect(n!.y).toBeLessThan(0.5);
    expect(e!.x).toBeGreaterThan(0.5);
    expect(e!.y).toBeCloseTo(0.5, 6);
  });

  it('nudges stacked dots apart', () => {
    const pts = layoutRadar(
      Array.from({ length: 6 }, (_, i) => ({
        id: String(i),
        minutes: 8,
        ring: 0 as const,
        bearing: 120,
      })),
    );
    for (let i = 0; i < pts.length; i++) {
      for (let j = 0; j < i; j++) {
        const d = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.y - pts[j]!.y);
        expect(d).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
      }
    }
  });

  it('keeps dots out from under the ring labels', () => {
    const [p] = layoutRadar([{ id: 'x', minutes: 10, ring: 0, bearing: 0 }]);
    const under = LABEL_BOXES.some(
      (b) => Math.abs(p!.x - b.x) < b.hw && Math.abs(p!.y - b.y) < b.hh,
    );
    expect(under).toBe(false);
  });
});
