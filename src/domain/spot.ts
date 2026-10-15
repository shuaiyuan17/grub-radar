// zod/mini: same validation, tree-shakable functional API, much smaller bundle
import { z } from 'zod/mini';

export const KINDS = ['food', 'coffee', 'bakery'] as const;
export const ICONS = [
  'bowl',
  'dumpling',
  'taco',
  'cup',
  'soup',
  'bun',
  'flame',
  'fish',
  'croissant',
] as const;

export const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
/** BCP 47 tags spot text may be written in. */
export const DATA_LANGS = ['en', 'zh-Hans'] as const;

const slug = z
  .string()
  .check(
    z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ids are lowercase-kebab-case, e.g. "lucky-thread"'),
  );
/** Trimmed, non-empty text, optionally capped. */
export const text = (max?: number) =>
  max === undefined
    ? z.string().check(z.trim(), z.minLength(1))
    : z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const between = (min: number, max: number) => z.number().check(z.gte(min), z.lte(max));

/** Size limits for everything a person (or an agent) can type into a spot. */
export const LIMITS = {
  name: 80,
  cuisine: 60,
  note: 60,
  tag: 30,
  tags: 10,
  dish: 80,
  dishes: 20,
  why: 500,
  /** One appended note entry. */
  entry: 500,
  myNote: 2000,
  /** Spots on one person's list. */
  spots: 1000,
  /** A place's one-line street address (from Apple Maps). */
  address: 200,
} as const;

export const PRICES = ['$', '$$', '$$$', '$$$$'] as const;
export const STATUSES = ['been', 'want'] as const;
/**
 * How it was, once you've been: three stamps, not a score. Best first, so
 * the index is the sort rank (see compareVerdicts).
 */
export const VERDICTS = ['good', 'meh', 'bad'] as const;

export const LatLngSchema = z.strictObject({ lat: between(-90, 90), lng: between(-180, 180) });
export const VerdictSchema = z.enum(VERDICTS);
export const TagSchema = z
  .string()
  .check(z.trim(), z.toLowerCase(), z.minLength(1), z.maxLength(LIMITS.tag));
export const TagsSchema = z.array(TagSchema).check(z.maxLength(LIMITS.tags));
/** Dish ids: "d1" … "d999999". Generation below stays inside this range. */
export const MAX_DISH_ID = 999_999;
const DISH_ID = /^d[1-9]\d{0,5}$/;
/** A dish to order. `id` is stable across edits ("d1", "d2", …); new dishes may omit it. */
export const DishSchema = z.strictObject({
  id: z.optional(z.string().check(z.regex(DISH_ID, 'dish ids look like "d3"'))),
  dish: text(LIMITS.dish),
  tried: z.boolean(),
});

/**
 * Gives every dish without an id (or with a duplicate one) a free "d<n>",
 * keeping existing ids. Prefers max + 1 (so a removed dish's id isn't reused
 * soon); past MAX_DISH_ID it takes the smallest free number instead, so a
 * generated id always passes DishSchema. (A list holds at most LIMITS.dishes,
 * so there is always one free.)
 */
export function withDishIds<T extends { id?: string }>(
  order: readonly T[],
): (T & { id: string })[] {
  const taken = new Set(order.map((o) => o.id).filter((id): id is string => id !== undefined));
  let next = 1 + Math.max(0, ...[...taken].map((id) => Number(id.slice(1))));
  const fresh = (): string => {
    while (next <= MAX_DISH_ID && taken.has(`d${String(next)}`)) next++;
    if (next > MAX_DISH_ID) {
      next = 1;
      while (taken.has(`d${String(next)}`)) next++;
    }
    const id = `d${String(next)}`;
    taken.add(id);
    return id;
  };
  const seen = new Set<string>();
  return order.map((o) => {
    const id = !o.id || seen.has(o.id) ? fresh() : o.id;
    seen.add(id);
    return { ...o, id };
  });
}

export const OrderSchema = z.pipe(
  z.array(DishSchema).check(z.maxLength(LIMITS.dishes)),
  z.transform((order) => withDishIds(order)),
);
/**
 * An Apple Maps Place ID ("IED91EBDD61F8ADEC"). Opaque to us; kept to a
 * conservative alphabet because it travels in URL paths.
 */
export const ApplePlaceIdSchema = z
  .string()
  .check(z.regex(/^[A-Za-z0-9._-]{1,100}$/, 'not an Apple Maps place id'));

export const WhySchema = z.strictObject({ text: text(LIMITS.why), foundOn: z.iso.date() });

export const HoursSchema = z.strictObject({
  closes: z.union([
    z.string().check(z.regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'closes is "HH:MM" (24h)')),
    z.literal('sold-out'),
  ]),
  days: z.optional(z.array(z.enum(DAYS)).check(z.minLength(1))),
});

export const SpotSchema = z
  .strictObject({
    id: slug,
    name: text(LIMITS.name),
    kind: z.enum(KINDS),
    /** Short, lowercase: "hand-pulled noodles". Optional: a coffee shop may just be coffee. */
    cuisine: z.optional(text(LIMITS.cuisine)),
    /** Absent: we don't know (Apple Maps doesn't say, and we never guess). */
    price: z.optional(z.enum(PRICES)),
    /** Lowercase craving tags; they become the filter chips. */
    tags: TagsSchema,
    status: z.enum(STATUSES),
    /** good / meh / bad. Only for places you've been. */
    verdict: z.optional(VerdictSchema),
    /** The one-liner in your handwriting voice. */
    note: z.optional(text(LIMITS.note)),
    order: OrderSchema,
    /** Written by the agent that found the place. */
    why: z.optional(WhySchema),
    /** Longer notes; `add_note` appends dated lines ("— 2026-10-14: …"). */
    myNote: z.optional(text(LIMITS.myNote)),
    /**
     * When it closes: 24h "HH:MM" ("00:00" = midnight), or "sold-out" for
     * places that close when they run out. `days` limits it ("fri only").
     */
    hours: z.optional(HoursSchema),
    /** Language the spot's own text (name, cuisine, notes, dishes) is written in. */
    lang: z.optional(z.enum(DATA_LANGS)),
    icon: z.enum(ICONS),
    location: LatLngSchema,
    /**
     * Set when the place came from Apple Maps. Such a place's name, location
     * and address are Apple's (shared by everyone who saved it), not editable.
     */
    applePlaceId: z.optional(ApplePlaceIdSchema),
    /** One-line street address, for places from Apple Maps. */
    address: z.optional(text(LIMITS.address)),
    /**
     * Bumped by the server on every write to this spot. Send it back with an
     * edit and a stale copy gets a 409 instead of overwriting newer data.
     */
    version: z.optional(z.int().check(z.gte(1))),
  })
  .check(
    z.refine((s) => s.verdict === undefined || s.status === 'been', {
      message: 'only give a verdict on places you have been to',
      path: ['verdict'],
    }),
  );

export type SpotInput = z.input<typeof SpotSchema>;
export type Spot = z.output<typeof SpotSchema>;
export type Kind = Spot['kind'];
export type IconName = Spot['icon'];
export type Hours = NonNullable<Spot['hours']>;
export type Day = (typeof DAYS)[number];
export type Price = (typeof PRICES)[number];
export type Verdict = (typeof VERDICTS)[number];
export type Status = Spot['status'];
export type Dish = Spot['order'][number];
export type DataLang = (typeof DATA_LANGS)[number];

/** The language a spot's own text is in (seed data is English unless marked). */
export function dataLang(spot: Pick<Spot, 'lang'>): DataLang {
  return spot.lang ?? 'en';
}

/**
 * Best first: good > meh > bad > no verdict. For anything that orders spots
 * by how they were (nothing does yet; agents and future views should use this).
 */
export function compareVerdicts(a: Verdict | undefined, b: Verdict | undefined): number {
  const rank = (v: Verdict | undefined) =>
    v === undefined ? VERDICTS.length : VERDICTS.indexOf(v);
  return rank(a) - rank(b);
}

/**
 * Cheapest first; an unknown price goes last (it isn't "cheap", we just
 * don't know).
 */
export function comparePrices(a: Price | undefined, b: Price | undefined): number {
  const rank = (p: Price | undefined) => (p === undefined ? PRICES.length : PRICES.indexOf(p));
  return rank(a) - rank(b);
}

/** Validates every spot and that ids are unique. Throws a readable error. */
export function parseSpots(input: unknown): Spot[] {
  const result = z.array(SpotSchema).safeParse(input);
  if (!result.success) {
    throw new Error(`Invalid spots data:\n${z.prettifyError(result.error)}`);
  }
  const seen = new Set<string>();
  for (const spot of result.data) {
    if (seen.has(spot.id)) throw new Error(`Invalid spots data: duplicate id "${spot.id}"`);
    seen.add(spot.id);
  }
  return result.data;
}
