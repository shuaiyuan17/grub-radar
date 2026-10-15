/**
 * Hand-drawn outlines without runtime SVG filters. Given an element's box and
 * its CSS border radii, build a rounded-rect path whose edge wobbles by a
 * smooth, periodic noise (so the outline closes cleanly). Deterministic per
 * seed, so an element keeps the same wobble across renders and resizes.
 *
 * Pure: no DOM. lib/ink.ts feeds it measurements.
 */

export interface Corner {
  x: number;
  y: number;
}
export type Radii = readonly [tl: Corner, tr: Corner, br: Corner, bl: Corner];

/** Peak wobble in px (the mockup's turbulence displacement was ±1.5px). */
export const WOBBLE_PX = 1.2;
/** Distance between sampled points along the outline, px. */
export const SAMPLE_PX = 10;

/** CSS border-radius overlap rule: scale every radius down if adjacent ones overlap. */
export function clampRadii(w: number, h: number, radii: Radii): Radii {
  const [tl, tr, br, bl] = radii;
  const f = Math.min(
    1,
    w / (tl.x + tr.x || 1),
    w / (bl.x + br.x || 1),
    h / (tl.y + bl.y || 1),
    h / (tr.y + br.y || 1),
  );
  const s = (c: Corner): Corner => ({ x: c.x * f, y: c.y * f });
  return [s(tl), s(tr), s(br), s(bl)];
}

/** mulberry32: tiny seeded PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth periodic noise over t in [0, 1): a few sines with whole-number frequencies. */
function noise(perimeter: number, seed: number): (t: number) => number {
  const r = rng(seed);
  const octaves = [
    { wavelength: 70, amp: 0.55 },
    { wavelength: 30, amp: 0.35 },
    { wavelength: 13, amp: 0.1 },
  ].map((o) => ({
    k: Math.max(1, Math.round(perimeter / o.wavelength)),
    amp: o.amp,
    phase: r() * Math.PI * 2,
  }));
  return (t) =>
    octaves.reduce((sum, o) => sum + o.amp * Math.sin(2 * Math.PI * o.k * t + o.phase), 0);
}

interface Pt {
  x: number;
  y: number;
  /** outward normal */
  nx: number;
  ny: number;
}

/** Points (with outward normals) around a rounded rect, roughly every `step` px. */
export function outlinePoints(w: number, h: number, radii: Radii, step = SAMPLE_PX): Pt[] {
  const [tl, tr, br, bl] = clampRadii(w, h, radii);
  const pts: Pt[] = [];
  const line = (x0: number, y0: number, x1: number, y1: number, nx: number, ny: number) => {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len / step));
    for (let i = 0; i < n; i++) {
      const t = i / n;
      pts.push({ x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, nx, ny });
    }
  };
  // quarter ellipse from angle a0 to a1 (radians, 0 = +x, y down) around (cx, cy)
  const arc = (cx: number, cy: number, rx: number, ry: number, a0: number) => {
    if (rx <= 0 || ry <= 0) return;
    const len = (Math.PI / 2) * Math.sqrt((rx * rx + ry * ry) / 2);
    const n = Math.max(2, Math.ceil(len / step));
    for (let i = 0; i < n; i++) {
      const a = a0 + (Math.PI / 2) * (i / n);
      const c = Math.cos(a);
      const s = Math.sin(a);
      // normal of an ellipse: (cos/rx, sin/ry), normalised
      const nx = c / rx;
      const ny = s / ry;
      const nl = Math.hypot(nx, ny) || 1;
      pts.push({ x: cx + rx * c, y: cy + ry * s, nx: nx / nl, ny: ny / nl });
    }
  };
  line(tl.x, 0, w - tr.x, 0, 0, -1);
  arc(w - tr.x, tr.y, tr.x, tr.y, -Math.PI / 2);
  line(w, tr.y, w, h - br.y, 1, 0);
  arc(w - br.x, h - br.y, br.x, br.y, 0);
  line(w - br.x, h, bl.x, h, 0, 1);
  arc(bl.x, h - bl.y, bl.x, bl.y, Math.PI / 2);
  line(0, h - bl.y, 0, tl.y, -1, 0);
  arc(tl.x, tl.y, tl.x, tl.y, Math.PI);
  return pts;
}

/**
 * The wobbly outline as an SVG path `d`, in the element's own px space.
 * `inset` pulls it inside the box (half the stroke width, like a CSS border).
 */
export function wobblyPath(
  w: number,
  h: number,
  radii: Radii,
  seed: number,
  inset = 0,
  amp = WOBBLE_PX,
): string {
  const iw = Math.max(0, w - inset * 2);
  const ih = Math.max(0, h - inset * 2);
  if (iw < 1 || ih < 1) return '';
  const shrink = (c: Corner): Corner => ({
    x: Math.max(0, c.x - inset),
    y: Math.max(0, c.y - inset),
  });
  const pts = outlinePoints(iw, ih, [
    shrink(radii[0]),
    shrink(radii[1]),
    shrink(radii[2]),
    shrink(radii[3]),
  ]);
  const perimeter = 2 * (iw + ih);
  const n = noise(perimeter, seed);
  const a = Math.min(amp, iw / 8, ih / 8);
  let d = '';
  pts.forEach((p, i) => {
    const off = a * n(i / pts.length);
    const x = (p.x + inset + p.nx * off).toFixed(1);
    const y = (p.y + inset + p.ny * off).toFixed(1);
    d += `${i === 0 ? 'M' : 'L'}${x} ${y}`;
  });
  return `${d}Z`;
}

/** Parse a computed border-radius corner ("18px 22px", "50%", "0px"). */
export function parseCorner(value: string, w: number, h: number): Corner {
  const [hx = '0', vy = hx] = value.trim().split(/\s+/);
  const px = (v: string, size: number) =>
    v.endsWith('%') ? (parseFloat(v) / 100) * size : parseFloat(v) || 0;
  return { x: px(hx, w), y: px(vy, h) };
}

/** Stable small hash for seeds (e.g. from React's useId). */
export function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
