/**
 * Picks a random item. Avoids handing back the previous pick when there's
 * anything else to choose, so "roll again" always feels like it did something.
 */
export function roll<T extends { id: string }>(
  items: readonly T[],
  previousId: string | null = null,
  random: () => number = Math.random,
): T | null {
  if (items.length === 0) return null;
  let k = Math.min(items.length - 1, Math.floor(random() * items.length));
  if (items.length > 1 && items[k]?.id === previousId) k = (k + 1) % items.length;
  return items[k] ?? null;
}
