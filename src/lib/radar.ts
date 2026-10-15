import type { Ring } from '../domain/travel';

/**
 * Radar geometry, all as fractions of the radar's diameter so it scales with
 * CSS. Ring outer edges follow the mockup (350px radar: 110/200/280/344).
 */
export const RING_DIAMETERS = [0.314, 0.571, 0.8, 0.983] as const;
export const HUB_DIAMETER = 0.114;

/**
 * Where a dot sits between the centre (0) and the outer ring (1), by minutes.
 * Each ring gets a band strictly inside its edges so dots never sit on a line.
 */
const BANDS: readonly (readonly [
  minMinutes: number,
  maxMinutes: number,
  from: number,
  to: number,
])[] = [
  [0, 10, 0.17, 0.29],
  [10, 30, 0.35, 0.53],
  [30, 60, 0.61, 0.76],
  [60, 180, 0.84, 0.93],
];

export function radiusFor(minutes: number, ring: Ring): number {
  const band = BANDS[ring];
  if (!band) return 0.93;
  const [lo, hi, from, to] = band;
  const t = Math.min(1, Math.max(0, (minutes - lo) / (hi - lo)));
  return from + t * (to - from);
}

export interface RadarInput {
  id: string;
  minutes: number;
  ring: Ring;
  /** Compass bearing from the origin; north is up. */
  bearing: number;
}

export interface RadarPoint {
  id: string;
  /** 0..1 from the left edge. */
  x: number;
  /** 0..1 from the top edge. */
  y: number;
}

/** Minimum gap between dot centres, as a fraction of the diameter. */
export const MIN_GAP = 0.065;
const NUDGE_DEG = 9;
const MAX_NUDGES = 40;

/**
 * Ring labels ("10 min", "30 min", ...) sit at the top of each ring; keep
 * dots out from under them. Boxes are centre + half-size, in diameter units.
 */
export const LABEL_BOXES = RING_DIAMETERS.map((d) => ({
  x: 0.5,
  y: 0.5 - d / 2,
  hw: 0.1,
  hh: 0.045,
}));

function hitsLabel(p: { x: number; y: number }): boolean {
  return LABEL_BOXES.some((b) => Math.abs(p.x - b.x) < b.hw && Math.abs(p.y - b.y) < b.hh);
}

function place(r: number, bearing: number): { x: number; y: number } {
  const a = (bearing * Math.PI) / 180;
  return { x: 0.5 + (r / 2) * Math.sin(a), y: 0.5 - (r / 2) * Math.cos(a) };
}

/**
 * Real compass direction, distance by travel time. Dots that overlap each
 * other or a ring label are nudged around their ring (same distance, slightly different angle) until
 * they're tappable. Deterministic for a given input order.
 */
export function layoutRadar(inputs: readonly RadarInput[]): RadarPoint[] {
  const placed: RadarPoint[] = [];
  for (const input of inputs) {
    const r = radiusFor(input.minutes, input.ring);
    let bearing = input.bearing;
    let p = place(r, bearing);
    for (let i = 0; i < MAX_NUDGES; i++) {
      const clash = hitsLabel(p) || placed.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < MIN_GAP);
      if (!clash) break;
      // Alternate directions so clusters fan out evenly: +9, -18, +27, ...
      bearing += (i % 2 === 0 ? 1 : -1) * NUDGE_DEG * (i + 1);
      p = place(r, bearing);
    }
    placed.push({ id: input.id, ...p });
  }
  return placed;
}
