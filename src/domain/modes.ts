import type { Spot } from './spot';
import { byTravelTime, type SpotView } from './spotView';

export const MODES = ['near', 'weekend', 'coffee'] as const;
export type Mode = (typeof MODES)[number];

export function isMode(value: unknown): value is Mode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

/** "near me" = food you can reach within this many minutes. */
export const NEAR_MAX_MINUTES = 20;
/** "weekend" = anything but coffee that's further than this. */
export const WEEKEND_MIN_MINUTES = 20;
/** "coffee" = coffee + bakeries within this many minutes. */
export const COFFEE_MAX_MINUTES = 30;

interface ModeDef {
  label: string;
  /** Headline split so the middle part gets the highlighter. */
  headline: readonly [string, string, string];
  sortLabel: string;
  emptyHint: string;
  includes: (v: SpotView) => boolean;
}

export const MODE_DEFS: Record<Mode, ModeDef> = {
  near: {
    label: 'near me',
    headline: ['what are we', 'eating', ' tonight?'],
    sortLabel: 'closest first',
    emptyHint: `nothing within ${NEAR_MAX_MINUTES} min. try weekend, or search.`,
    includes: (v) => v.spot.kind === 'food' && v.travel.minutes <= NEAR_MAX_MINUTES,
  },
  weekend: {
    label: 'weekend',
    headline: ["it's the weekend.", 'go further', '.'],
    sortLabel: 'by drive time',
    emptyHint: 'no far-flung ideas yet.',
    includes: (v) => v.spot.kind !== 'coffee' && v.travel.minutes > WEEKEND_MIN_MINUTES,
  },
  coffee: {
    label: 'coffee',
    headline: ['first,', 'coffee', '.'],
    sortLabel: 'closest first',
    emptyHint: `no coffee within ${COFFEE_MAX_MINUTES} min. that's a problem.`,
    includes: (v) => v.spot.kind !== 'food' && v.travel.minutes <= COFFEE_MAX_MINUTES,
  },
};

export const ALL = 'all';

export function spotsForMode(views: readonly SpotView[], mode: Mode): SpotView[] {
  return views.filter(MODE_DEFS[mode].includes).sort(byTravelTime);
}

/**
 * Chips for a set of spots. A spot's first tag says what it *is* (noodles,
 * tacos), later tags are modifiers (spicy, cheap); "what it is" chips come
 * first. Within each group, order of first appearance in the data file.
 */
export function chipsFor(spots: readonly Spot[]): string[] {
  const primary: string[] = [];
  const secondary: string[] = [];
  for (const s of spots) {
    s.tags.forEach((tag, i) => {
      if (primary.includes(tag) || secondary.includes(tag)) return;
      (i === 0 ? primary : secondary).push(tag);
    });
  }
  // A tag that's primary somewhere wins over secondary-elsewhere.
  return [ALL, ...primary, ...secondary.filter((t) => !primary.includes(t))];
}

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function haystack(s: Spot): string {
  return normalize(
    [
      s.name,
      s.cuisine,
      s.kind,
      s.note,
      s.why?.text ?? '',
      s.myNote ?? '',
      ...s.tags,
      ...s.order.map((o) => o.dish),
    ].join(' '),
  );
}

/** Every whitespace-separated word of the query must appear somewhere. */
export function matchesQuery(spot: Spot, query: string): boolean {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = haystack(spot);
  return words.every((w) => hay.includes(w));
}

export interface ListQuery {
  mode: Mode;
  tag: string;
  q: string;
}

export interface ListResult {
  items: SpotView[];
  chips: string[];
  /** The tag actually applied (falls back to "all" if it no longer exists). */
  tag: string;
  searching: boolean;
}

/**
 * The list view. A search looks across every spot (ignoring mode and chips),
 * because when you type "dumplings" you want dumplings, wherever they are.
 */
export function listSpots(views: readonly SpotView[], { mode, tag, q }: ListQuery): ListResult {
  const query = q.trim();
  if (query) {
    return {
      items: views.filter((v) => matchesQuery(v.spot, query)).sort(byTravelTime),
      chips: [],
      tag: ALL,
      searching: true,
    };
  }
  const inMode = spotsForMode(views, mode);
  // chips follow data-file order, not distance, so they don't reshuffle when you move
  const chips = chipsFor(views.filter(MODE_DEFS[mode].includes).map((v) => v.spot));
  const applied = chips.includes(tag) ? tag : ALL;
  const items = applied === ALL ? inMode : inMode.filter((v) => v.spot.tags.includes(applied));
  return { items, chips, tag: applied, searching: false };
}
