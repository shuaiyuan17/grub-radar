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

const slug = z
  .string()
  .check(
    z.regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ids are lowercase-kebab-case, e.g. "lucky-thread"'),
  );
const text = (max?: number) =>
  max === undefined
    ? z.string().check(z.trim(), z.minLength(1))
    : z.string().check(z.trim(), z.minLength(1), z.maxLength(max));
const between = (min: number, max: number) => z.number().check(z.gte(min), z.lte(max));

export const SpotSchema = z
  .strictObject({
    id: slug,
    name: text(),
    kind: z.enum(KINDS),
    /** Short, lowercase: "hand-pulled noodles". */
    cuisine: text(),
    price: z.enum(['$', '$$', '$$$', '$$$$']),
    /** Lowercase craving tags; they become the filter chips. */
    tags: z.array(z.string().check(z.trim(), z.toLowerCase(), z.minLength(1))),
    status: z.enum(['been', 'want']),
    /** Out of 10. Only for places you've been. */
    rating: z.optional(z.int().check(z.gte(1), z.lte(10))),
    /** The one-liner in your handwriting voice. */
    note: text(60),
    order: z.array(z.strictObject({ dish: text(), tried: z.boolean() })),
    /** Written by the agent that found the place. */
    why: z.optional(z.strictObject({ text: text(), foundOn: z.iso.date() })),
    myNote: z.optional(text()),
    /** Free text, e.g. "10pm". */
    openTill: z.optional(text()),
    icon: z.enum(ICONS),
    location: z.strictObject({ lat: between(-90, 90), lng: between(-180, 180) }),
  })
  .check(
    z.refine((s) => s.rating === undefined || s.status === 'been', {
      message: 'only rate places you have been to',
      path: ['rating'],
    }),
  );

export type SpotInput = z.input<typeof SpotSchema>;
export type Spot = z.output<typeof SpotSchema>;
export type Kind = Spot['kind'];
export type IconName = Spot['icon'];

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
