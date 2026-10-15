import { z } from 'zod';

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
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'ids are lowercase-kebab-case, e.g. "lucky-thread"');

export const SpotSchema = z
  .object({
    id: slug,
    name: z.string().trim().min(1),
    kind: z.enum(KINDS),
    /** Short, lowercase: "hand-pulled noodles". */
    cuisine: z.string().trim().min(1),
    price: z.enum(['$', '$$', '$$$', '$$$$']),
    /** Lowercase craving tags; they become the filter chips. */
    tags: z.array(z.string().trim().toLowerCase().min(1)),
    status: z.enum(['been', 'want']),
    /** Out of 10. Only for places you've been. */
    rating: z.number().int().min(1).max(10).optional(),
    /** The one-liner in your handwriting voice. */
    note: z.string().trim().min(1).max(60),
    order: z.array(z.object({ dish: z.string().trim().min(1), tried: z.boolean() })),
    /** Written by the agent that found the place. */
    why: z.object({ text: z.string().trim().min(1), foundOn: z.iso.date() }).optional(),
    myNote: z.string().trim().min(1).optional(),
    /** Free text, e.g. "10pm". */
    openTill: z.string().trim().min(1).optional(),
    icon: z.enum(ICONS),
    location: z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
    }),
  })
  .strict()
  .refine((s) => s.rating === undefined || s.status === 'been', {
    message: 'only rate places you have been to',
    path: ['rating'],
  });

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
