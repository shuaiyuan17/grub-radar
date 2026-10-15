import { HEADLINE_COPY } from '../copy/headlines';
import { pickHeadline, type PickedHeadline } from '../domain/headlines';
import type { Locale } from '../i18n/locales';

let draw: { date: Date; r: number } | null = null;

/**
 * The headline for this page load. The moment and the random draw are taken
 * once, on first call, then reused, so the line never flickers on re-render
 * or when you navigate back. Switching language picks the same slot and
 * draw from that language's lines. Clock and RNG are injectable for tests.
 */
export function getPageHeadline(
  locale: Locale = 'en',
  now: () => Date = () => new Date(),
  random: () => number = Math.random,
): PickedHeadline {
  draw ??= { date: now(), r: random() };
  const { date, r } = draw;
  return pickHeadline(date, () => r, HEADLINE_COPY[locale]);
}

/** Tests only: forget the draw so the next call draws again. */
export function resetPageHeadline(): void {
  draw = null;
}
