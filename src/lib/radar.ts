import type { Ring } from '../domain/travel';

/**
 * Radar geometry. Positions are fractions of the radar's diameter so they
 * scale with CSS; spacing is worked out in px for the rendered size, so tap
 * targets never overlap. Ring outer edges follow the mockup (350px radar:
 * 110/200/280/344).
 */
export const RING_DIAMETERS = [0.314, 0.571, 0.8, 0.983] as const;
export const HUB_DIAMETER = 0.114;
/** Radar width the phone layout renders at (390px screen minus padding). */
export const PHONE_RADAR_PX = 350;
/** Tappable dot size (WCAG-ish minimum; the visible mark is smaller). */
export const DOT_TARGET_PX = 40;
/** Visible dot mark size (+ breathing room) for decorations it shouldn't cover. */
export const MARK_CLEAR_PX = 16 + 8;
/** Hub size clamp, mirrors the CSS clamp(32px, 11.4%, 52px). */
export const hubPx = (size: number) => Math.min(52, Math.max(32, HUB_DIAMETER * size));
/** Ring labels ("10 min") sit centred on the top of each ring. */
export const LABEL_PX = { w: 62, h: 20 } as const;

/**
 * Where a dot may sit, as distance-from-centre in diameter units (0..0.5),
 * by ring. Each ring gets a band inside its own edges.
 */
const BANDS: readonly (readonly [lo: number, hi: number, from: number, to: number])[] = [
  [0, 10, 0.085, 0.15],
  [10, 30, 0.175, 0.27],
  [30, 60, 0.305, 0.385],
  [60, 180, 0.42, 0.47],
];

/** Preferred distance from centre (diameter units) for a travel time in a ring. */
export function radiusFor(minutes: number, ring: Ring): number {
  const band = BANDS[ring];
  if (!band) return 0.47;
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

export interface LayoutOptions {
  /** Rendered radar width in px. */
  size?: number;
  /** Size of each dot's hit area in px. */
  target?: number;
}

const toXY = (dist: number, bearing: number) => {
  const a = (bearing * Math.PI) / 180;
  return { x: 0.5 + dist * Math.sin(a), y: 0.5 - dist * Math.cos(a) };
};

/**
 * Real compass direction, distance by travel time. If a dot's spot would
 * overlap another dot, the home hub, or a ring label, it searches nearby
 * angles and radii within its own ring band, closest to where it wanted to
 * be first. Deterministic for a given input order.
 */
export function layoutRadar(
  inputs: readonly RadarInput[],
  { size = PHONE_RADAR_PX, target = DOT_TARGET_PX }: LayoutOptions = {},
): RadarPoint[] {
  const gap = target / size; // min centre-to-centre distance, diameter units
  // Tap targets must not overlap each other. The hub and ring labels aren't
  // tappable, so there we only keep the visible mark clear of them.
  const hubClear = (hubPx(size) / 2 + MARK_CLEAR_PX / 2) / size;
  const labels = RING_DIAMETERS.map((d) => ({
    x: 0.5,
    y: 0.5 - d / 2,
    hw: (LABEL_PX.w / 2 + MARK_CLEAR_PX / 2) / size,
    hh: (LABEL_PX.h / 2 + MARK_CLEAR_PX / 2) / size,
  }));

  const placed: RadarPoint[] = [];
  const clearance = (p: { x: number; y: number }) => {
    let worst = Infinity;
    for (const q of placed) worst = Math.min(worst, Math.hypot(q.x - p.x, q.y - p.y) / gap);
    worst = Math.min(worst, Math.hypot(p.x - 0.5, p.y - 0.5) / hubClear);
    for (const b of labels) {
      // inside the label box counts as a clash; scale how deep
      const dx = Math.abs(p.x - b.x) / b.hw;
      const dy = Math.abs(p.y - b.y) / b.hh;
      worst = Math.min(worst, Math.max(dx, dy));
    }
    return worst; // >= 1 means no overlap
  };

  for (const input of inputs) {
    const band = BANDS[input.ring] ?? BANDS[3];
    const [, , from, to] = band ?? [0, 0, 0.42, 0.47];
    const want = radiusFor(input.minutes, input.ring);
    // radii to try: preferred first, then outwards across the band
    const radii = [want];
    for (let k = 1; k <= 8; k++) {
      radii.push(want + ((to - from) * k) / 8, want - ((to - from) * k) / 8);
    }
    const okRadii = radii.filter((r) => r >= from - 1e-9 && r <= to + 1e-9);
    let best: { x: number; y: number } | null = null;
    let bestScore = -Infinity;
    search: for (let step = 0; step <= 120; step++) {
      // 0, +3, -3, +6, -6 ... degrees, all the way round
      const delta = step === 0 ? 0 : (step % 2 === 1 ? 1 : -1) * Math.ceil(step / 2) * 3;
      for (const r of okRadii) {
        const p = toXY(r, input.bearing + delta);
        const c = clearance(p);
        if (c >= 1) {
          best = p;
          break search;
        }
        if (c > bestScore) {
          bestScore = c;
          best = p;
        }
      }
    }
    const p = best ?? toXY(want, input.bearing);
    placed.push({ id: input.id, x: p.x, y: p.y });
  }
  return placed;
}
