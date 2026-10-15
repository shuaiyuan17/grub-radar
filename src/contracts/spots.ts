import { z } from 'zod/mini';
import { parseLatLng, type LatLng } from '../domain/geo';
import { KINDS, LatLngSchema, RatingSchema, SpotSchema, type Kind } from '../domain/spot';

/**
 * Wire shapes for /api/spots*, /api/roll and /api/me/home. Request bodies for
 * the writes (AddSpotSchema, SpotPatchSchema, MarkBeenSchema, AddNoteSchema)
 * are domain operations and live in src/domain/edits.ts.
 */

/** PUT /api/me/home. Always in the body, never a query string (access logs). */
export const HomeSchema = LatLngSchema;

/** Where to measure from: your saved home (resolved server-side) or explicit coordinates. */
export type Origin = 'home' | LatLng;
export const OriginSchema = z.union([z.literal('home'), LatLngSchema]);

export const NEARBY_DEFAULT_LIMIT = 10;
export const NEARBY_MAX_LIMIT = 50;

export interface NearbyQuery {
  origin: Origin;
  maxMinutes?: number;
  kinds?: Kind[];
  limit: number;
}

const positive = z.number().check(z.gt(0), z.lte(24 * 60));
const KindsSchema = z.array(z.enum(KINDS)).check(z.minLength(1));

/**
 * GET /api/spots/nearby?origin=home|lat,lng&maxMinutes=30&kinds=food,coffee&limit=10.
 * Returns the parsed query or a message saying what's wrong.
 */
export function parseNearbyQuery(params: URLSearchParams): NearbyQuery | { error: string } {
  const rawOrigin = params.get('origin') ?? 'home';
  const origin = rawOrigin === 'home' ? 'home' : parseLatLng(rawOrigin);
  if (!origin) return { error: 'origin is "home" or "lat,lng"' };
  const out: NearbyQuery = { origin, limit: NEARBY_DEFAULT_LIMIT };
  const max = params.get('maxMinutes');
  if (max !== null) {
    const parsed = positive.safeParse(Number(max));
    if (!parsed.success || max.trim() === '') return { error: 'maxMinutes is 1..1440' };
    out.maxMinutes = parsed.data;
  }
  const kinds = params.get('kinds');
  if (kinds !== null) {
    const parsed = KindsSchema.safeParse(kinds.split(',').map((k) => k.trim()));
    if (!parsed.success) return { error: `kinds is a comma list of ${KINDS.join(', ')}` };
    out.kinds = [...new Set(parsed.data)];
  }
  const limit = params.get('limit');
  if (limit !== null) {
    const n = Number(limit);
    if (!Number.isInteger(n) || n < 1 || n > NEARBY_MAX_LIMIT)
      return { error: `limit is 1..${NEARBY_MAX_LIMIT}` };
    out.limit = n;
  }
  return out;
}

/** POST /api/roll (the `roll` tool). */
export const RollBodySchema = z.strictObject({
  origin: OriginSchema,
  maxMinutes: z.optional(positive),
  kinds: z.optional(KindsSchema),
  previousId: z.optional(z.string().check(z.maxLength(100))),
});
export type RollBody = z.infer<typeof RollBodySchema>;

export const NearbySpotSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  kind: z.enum(KINDS),
  cuisine: z.optional(z.string()),
  status: z.enum(['been', 'want']),
  rating: z.optional(RatingSchema),
  note: z.optional(z.string()),
  tags: z.array(z.string()),
  minutes: z.number(),
  mode: z.enum(['walk', 'drive']),
  km: z.number(),
  miles: z.number(),
  ring: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  location: z.optional(LatLngSchema),
});

/** GET /api/spots/nearby */
export const NearbyResponseSchema = z.strictObject({ spots: z.array(NearbySpotSchema) });
/** POST /api/roll */
export const RollResponseSchema = z.strictObject({ spot: z.nullable(NearbySpotSchema) });

/** GET /api/spots */
export const SpotListSchema = z.array(SpotSchema);
