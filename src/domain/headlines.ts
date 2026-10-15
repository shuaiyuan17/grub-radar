import { HEADLINE_COPY, type Slot } from '../copy/headlines';
import type { Mode } from './modes';

export type { Slot };
export type HeadlineParts = readonly [before: string, highlight: string, after: string];
export type HeadlineCopy = Readonly<Record<Slot, readonly string[]>>;

/** Local-time slot boundaries, in hours (start inclusive, end exclusive). */
export const SLOT_HOURS = {
  breakfast: [5, 11],
  lunch: [11, 14],
  afternoon: [14, 17],
  dinner: [17, 21],
  // late night is everything else: 21:00–4:59
  weekendDay: [9, 17],
} as const;

/** Which slot a moment falls in, in the device's local time. */
export function slotFor(date: Date): Slot {
  const h = date.getHours();
  const day = date.getDay(); // 0 = Sunday, 6 = Saturday
  const inRange = ([start, end]: readonly [number, number]) => h >= start && h < end;
  if ((day === 0 || day === 6) && inRange(SLOT_HOURS.weekendDay)) return 'weekendDay';
  if (inRange(SLOT_HOURS.breakfast)) return 'breakfast';
  if (inRange(SLOT_HOURS.lunch)) return 'lunch';
  if (inRange(SLOT_HOURS.afternoon)) return 'afternoon';
  if (inRange(SLOT_HOURS.dinner)) return 'dinner';
  return 'lateNight';
}

/** The list mode a slot opens in. Weekend days default to weekend ideas. */
export function defaultModeFor(slot: Slot): Mode {
  return slot === 'weekendDay' ? 'weekend' : 'near';
}

/** "what are we *eating* tonight?" -> ["what are we ", "eating", " tonight?"] */
export function parseHeadline(line: string): HeadlineParts {
  const parts = line.split('*');
  const [before, highlight, after] = parts;
  if (parts.length !== 3 || before === undefined || !highlight || after === undefined) {
    throw new Error(`headline needs exactly one *highlight*: ${JSON.stringify(line)}`);
  }
  return [before, highlight, after];
}

export interface PickedHeadline {
  slot: Slot;
  /** Index into the slot's variants. */
  variant: number;
  parts: HeadlineParts;
  defaultMode: Mode;
}

/** Pure: same date + same rng sequence = same headline. */
export function pickHeadline(
  date: Date,
  random: () => number = Math.random,
  copy: HeadlineCopy = HEADLINE_COPY.en,
): PickedHeadline {
  const slot = slotFor(date);
  const variants = copy[slot];
  if (variants.length === 0) throw new Error(`no headlines for slot "${slot}"`);
  const variant = Math.min(variants.length - 1, Math.floor(random() * variants.length));
  return {
    slot,
    variant,
    parts: parseHeadline(variants[variant] ?? ''),
    defaultMode: defaultModeFor(slot),
  };
}

/** Small deterministic PRNG (mulberry32), handy for tests and reproducible picks. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
