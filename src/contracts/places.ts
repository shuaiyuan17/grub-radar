import { z } from 'zod/mini';
import { ADD_EXTRAS, verdictNeedsBeen } from '../domain/edits';
import { parseLatLng, type LatLng } from '../domain/geo';
import {
  ApplePlaceIdSchema,
  DATA_LANGS,
  KINDS,
  LatLngSchema,
  SpotSchema,
  type DataLang,
  type Kind,
} from '../domain/spot';
import { OriginSchema, type Origin } from './spots';

/**
 * Wire shapes for Apple Maps places: GET /api/places/search (the future
 * `search_places` tool), GET /api/places/:applePlaceId, and the two Apple
 * forms of POST /api/spots (`add_spot` with an `applePlaceId`, or with a
 * free-text `query`).
 */

/** The Apple Maps POI categories we search, and the kind each becomes. */
export const POI_CATEGORIES = ['Restaurant', 'Cafe', 'Bakery'] as const;
export type PoiCategory = (typeof POI_CATEGORIES)[number];
export const KIND_FOR_CATEGORY: Record<PoiCategory, Kind> = {
  Restaurant: 'food',
  Cafe: 'coffee',
  Bakery: 'bakery',
};
export const isPoiCategory = (s: unknown): s is PoiCategory =>
  typeof s === 'string' && (POI_CATEGORIES as readonly string[]).includes(s);

/** A place on Apple Maps, as we hand it to the app and to agents. */
export const ApplePlaceSchema = z.strictObject({
  applePlaceId: ApplePlaceIdSchema,
  name: z.string(),
  /** One line: "2001 4th Ave, Seattle, WA 98121". */
  address: z.optional(z.string()),
  location: LatLngSchema,
  /** Apple's POI category, when Apple says (search results always do). */
  category: z.optional(z.enum(POI_CATEGORIES)),
  /** The kind it becomes on your list (from `category`). */
  kind: z.optional(z.enum(KINDS)),
});
export type ApplePlace = z.infer<typeof ApplePlaceSchema>;

/** GET /api/places/search; at most SEARCH_MAX_RESULTS, Apple's order (best match first). */
export const PlaceSearchResponseSchema = z.strictObject({ places: z.array(ApplePlaceSchema) });
export type PlaceSearchResponse = z.infer<typeof PlaceSearchResponseSchema>;

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_MAX_CHARS = 100;
export const SEARCH_MAX_RESULTS = 10;

/**
 * The query as it's searched and cached: NFKC, lowercase, single spaces. So
 * "Serious  Pie" and "serious pie" are one search (and one cache entry).
 */
export const normalizeQuery = (q: string) =>
  q.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * Search centres are rounded to 2 decimals (about 1 km): enough for "near
 * me", nearby searches share a cache entry, and a precise point (home) never
 * goes to Apple or into a cache key.
 */
export const roundForSearch = (p: LatLng): LatLng => ({
  lat: Math.round(p.lat * 100) / 100,
  lng: Math.round(p.lng * 100) / 100,
});

export interface PlaceSearchQuery {
  q: string;
  /** Search around here. Absent: around your home if you saved one, else anywhere. */
  near?: Origin;
  /** Language for names and addresses. */
  lang: DataLang;
}

/** A search request, from a query string or a JSON body: the parsed query, or what's wrong. */
function toSearchQuery(raw: {
  q: unknown;
  near: unknown;
  lang: unknown;
}): PlaceSearchQuery | { error: string } {
  const q = normalizeQuery(typeof raw.q === 'string' ? raw.q : '');
  if (q.length < SEARCH_MIN_CHARS || q.length > SEARCH_MAX_CHARS)
    return { error: `q is ${SEARCH_MIN_CHARS}..${SEARCH_MAX_CHARS} characters` };
  const out: PlaceSearchQuery = { q, lang: 'en' };
  if (raw.near !== undefined && raw.near !== null) {
    const near = OriginSchema.safeParse(
      typeof raw.near === 'string' && raw.near !== 'home' ? parseLatLng(raw.near) : raw.near,
    );
    if (!near.success) return { error: 'near is "home" or a point (lat, lng)' };
    out.near = near.data;
  }
  if (raw.lang !== undefined && raw.lang !== null) {
    if (typeof raw.lang !== 'string' || !(DATA_LANGS as readonly string[]).includes(raw.lang))
      return { error: `lang is one of ${DATA_LANGS.join(', ')}` };
    out.lang = raw.lang as DataLang;
  }
  return out;
}

/**
 * GET /api/places/search?q=pho&near=home|lat,lng&lang=en|zh-Hans (agents, curl).
 * Returns the parsed query (q normalized) or what's wrong.
 */
export function parsePlaceSearchQuery(
  params: URLSearchParams,
): PlaceSearchQuery | { error: string } {
  return toSearchQuery({ q: params.get('q'), near: params.get('near'), lang: params.get('lang') });
}

/**
 * POST /api/places/search { q, near?, lang? }: the same search, but where
 * you are travels in the body, never in a URL (access logs). The app uses this.
 */
export function parsePlaceSearchBody(body: unknown): PlaceSearchQuery | { error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  const extra = Object.keys(b).filter((k) => k !== 'q' && k !== 'near' && k !== 'lang');
  if (extra.length) return { error: `unknown field: ${extra.join(', ')}` };
  return toSearchQuery({ q: b.q, near: b.near, lang: b.lang });
}

/**
 * POST /api/spots with an Apple Maps place (`add_spot` with `applePlaceId`).
 * Name, location and address come from Apple (never from the request), in
 * English: the place row is shared by everyone who saves it. `kind`
 * defaults to what Apple says the place is, else food.
 */
export const AddApplePlaceSchema = z
  .strictObject({
    applePlaceId: ApplePlaceIdSchema,
    kind: z.optional(z.enum(KINDS)),
    ...ADD_EXTRAS,
  })
  .check(verdictNeedsBeen());
export type AddApplePlaceInput = z.input<typeof AddApplePlaceSchema>;
export type AddApplePlace = z.output<typeof AddApplePlaceSchema>;

/**
 * POST /api/spots with words (`add_spot` with `query`): Apple Maps is
 * searched around `near` (or your home; one of them is required) and the
 * match is added only when it's clearly the one (see the Worker's
 * confidentMatch); otherwise 409 `ambiguous` with the candidates.
 */
export const AddByQuerySchema = z
  .strictObject({
    query: z
      .string()
      .check(
        z.trim(),
        z.minLength(SEARCH_MIN_CHARS, `at least ${SEARCH_MIN_CHARS} characters`),
        z.maxLength(SEARCH_MAX_CHARS),
      ),
    near: z.optional(OriginSchema),
    kind: z.optional(z.enum(KINDS)),
    ...ADD_EXTRAS,
  })
  .check(verdictNeedsBeen());
export type AddByQuery = z.output<typeof AddByQuerySchema>;

/**
 * POST /api/spots with `query` answers with how it was resolved (201, or
 * 200 if the place was already on your list), so the caller can tell the
 * person what was added and offer the runners-up.
 */
export const AddByQueryResponseSchema = z.strictObject({
  spot: SpotSchema,
  created: z.boolean(),
  resolvedFrom: z.literal('apple'),
  alternatives: z.array(ApplePlaceSchema),
});
export type AddByQueryResponse = z.infer<typeof AddByQueryResponseSchema>;

/** 409 `ambiguous`: no clear match; nothing was added. Pick one and add it by `applePlaceId`. */
export const AmbiguousResponseSchema = z.strictObject({
  error: z.strictObject({ code: z.literal('ambiguous'), message: z.string() }),
  candidates: z.array(ApplePlaceSchema),
});

/** Which form of POST /api/spots a body is: by Apple id, by words, or by hand. */
export function addSpotForm(body: unknown): 'apple' | 'query' | 'manual' {
  if (body && typeof body === 'object') {
    if ('applePlaceId' in body) return 'apple';
    if ('query' in body) return 'query';
  }
  return 'manual';
}
