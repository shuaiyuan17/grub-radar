import { pickHeadline, type PickedHeadline } from '../domain/headlines';

let picked: PickedHeadline | null = null;

/**
 * The headline for this page load: picked on first call, then fixed, so it
 * never flickers on re-render or when you navigate back to the list.
 * Clock and RNG are injectable for tests.
 */
export function getPageHeadline(
  now: () => Date = () => new Date(),
  random: () => number = Math.random,
): PickedHeadline {
  picked ??= pickHeadline(now(), random);
  return picked;
}

/** Tests only: forget the pick so the next call picks again. */
export function resetPageHeadline(): void {
  picked = null;
}
