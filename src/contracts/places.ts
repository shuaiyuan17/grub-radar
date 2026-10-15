import { z } from 'zod/mini';
import { ADD_EXTRAS, ratingNeedsBeen } from '../domain/edits';
import { parseLatLng, type LatLng } from '../domain/geo';
import {
  ApplePlaceIdSchema,
  DATA_LANGS,
  KINDS,
  LatLngSchema,
  text,
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

/**
 * GET /api/places/search?q=pho&near=home|lat,lng&lang=en|zh-Hans.
 * Returns the parsed query (q normalized) or what's wrong.
 */
export function parsePlaceSearchQuery(
  params: URLSearchParams,
): PlaceSearchQuery | { error: string } {
  const q = normalizeQuery(params.get('q') ?? '');
  if (q.length < SEARCH_MIN_CHARS || q.length > SEARCH_MAX_CHARS)
    return { error: `q is ${SEARCH_MIN_CHARS}..${SEARCH_MAX_CHARS} characters` };
  const out: PlaceSearchQuery = { q, lang: 'en' };
  const near = params.get('near');
  if (near !== null) {
    const origin = near === 'home' ? 'home' : parseLatLng(near);
    if (!origin) return { error: 'near is "home" or "lat,lng"' };
    out.near = origin;
  }
  const lang = params.get('lang');
  if (lang !== null) {
    if (!(DATA_LANGS as readonly string[]).includes(lang))
      return { error: `lang is one of ${DATA_LANGS.join(', ')}` };
    out.lang = lang as DataLang;
  }
  return out;
}

/**
 * POST /api/spots with an Apple Maps place (`add_spot` with `applePlaceId`).
 * Name, location and address come from Apple (never from the request);
 * `kind` defaults to what Apple says the place is, else food.
 */
export const AddApplePlaceSchema = z
  .strictObject({
    applePlaceId: ApplePlaceIdSchema,
    kind: z.optional(z.enum(KINDS)),
    /** Language for the place's name and address, if Apple has to be asked. Default en. */
    lang: z.optional(z.enum(DATA_LANGS)),
    ...ADD_EXTRAS,
  })
  .check(ratingNeedsBeen());
export type AddApplePlaceInput = z.input<typeof AddApplePlaceSchema>;
export type AddApplePlace = z.output<typeof AddApplePlaceSchema>;

/**
 * POST /api/spots with words (`add_spot` with `query`): Apple Maps is
 * searched around `near` (default: your home) and the best match is added.
 */
export const AddByQuerySchema = z
  .strictObject({
    query: text(SEARCH_MAX_CHARS),
    near: z.optional(OriginSchema),
    kind: z.optional(z.enum(KINDS)),
    lang: z.optional(z.enum(DATA_LANGS)),
    ...ADD_EXTRAS,
  })
  .check(ratingNeedsBeen());
export type AddByQuery = z.output<typeof AddByQuerySchema>;

/** Which form of POST /api/spots a body is: by Apple id, by words, or by hand. */
export function addSpotForm(body: unknown): 'apple' | 'query' | 'manual' {
  if (body && typeof body === 'object') {
    if ('applePlaceId' in body) return 'apple';
    if ('query' in body) return 'query';
  }
  return 'manual';
}
