/**
 * The spot operations behind both doors: REST routes call these now, the MCP
 * tools (PR 6) will be thin adapters over the same functions. Each takes the
 * repository for the calling principal's user, so scoping is decided once,
 * when the repository is built.
 */
import type {
  AddApplePlace,
  AddByQuery,
  AddSharedPlace,
  ApplePlace,
} from '../../src/contracts/places';
import type { NearbyQuery, Origin, RollBody } from '../../src/contracts/spots';
import { SpotOpError, type AddSpot } from '../../src/domain/edits';
import type { LatLng } from '../../src/domain/geo';
import { findNearby, toNearbySpot, type NearbySpot } from '../../src/domain/nearby';
import type { SpotView } from '../../src/domain/spotView';
import type { SpotRepository } from '../../src/domain/repository';
import { normalizeSearch } from '../../src/domain/modes';
import { roll } from '../../src/domain/roll';
import type { Spot } from '../../src/domain/spot';
import type { D1SpotRepository } from '../db/spots';
import { getHome } from '../db/users';
import type { AppleMaps } from './appleMaps';

// ---------------------------------------------------------------------------
// Home, for agents (memo S2): an agent may measure from "home", but must not be
// able to work out where home is. Distances from a precise home to spots whose
// coordinates it knows would give it away by trilateration, so for anyone but
// the person themselves home is first snapped to the centre of a ~1 km grid
// cell, and distances come back coarse. Home's coordinates are never returned.

/** Grid cell size for an agent's view of home. */
export const HOME_GRID_KM = 1;
const KM_PER_DEGREE_LAT = 111.32;

/**
 * The centre of the ~HOME_GRID_KM grid cell `p` falls in. Every point in the
 * cell gives the same answer, so nothing computed from it can tell them apart.
 */
export function snapToGrid(p: LatLng, cellKm = HOME_GRID_KM): LatLng {
  const latStep = cellKm / KM_PER_DEGREE_LAT;
  const lat = (Math.floor(p.lat / latStep) + 0.5) * latStep;
  // longitude cells keep ~cellKm wide at this latitude band (fixed per band, so still a grid)
  const lngStep = latStep / Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const lng = (Math.floor(p.lng / lngStep) + 0.5) * lngStep;
  return { lat, lng };
}

/**
 * km and miles to the nearest 0.5, never below 0.5: what an agent sees for a distance from home.
 * Home is only known to within ~700 m, so "0" would claim a precision we don't give (and next to
 * "0.5 km" it read as a bug: 0.3 km rounds up, the same 0.19 mi rounded down).
 */
export const coarseDistance = (n: number) => Math.max(0.5, Math.round(n * 2) / 2);

export type OriginResult =
  | {
      ok: true;
      origin: LatLng;
      isHome: boolean;
      /** Home, as an agent sees it: snapped to the grid, distances rounded to 0.5. */
      coarse: boolean;
    }
  | { ok: false };

/**
 * 'home' becomes the saved home (never echoed back); coordinates pass
 * through. `coarse`: the caller isn't the person themselves (an agent), so
 * home is snapped to the grid before any distance is measured from it.
 */
export async function resolveOrigin(
  db: D1Database,
  userId: string,
  origin: Origin,
  { coarse = false }: { coarse?: boolean } = {},
): Promise<OriginResult> {
  if (origin !== 'home') return { ok: true, origin, isHome: false, coarse: false };
  const home = await getHome(db, userId);
  if (!home) return { ok: false };
  return coarse
    ? { ok: true, origin: snapToGrid(home), isHome: true, coarse: true }
    : { ok: true, origin: home, isHome: true, coarse: false };
}

type ResolvedOrigin = Extract<OriginResult, { ok: true }>;

/** One result as the caller may see it: no location from home; coarse distances for agents. */
function present(v: SpotView, origin: ResolvedOrigin): NearbySpot {
  const out = toNearbySpot(v, !origin.isHome);
  return origin.coarse
    ? { ...out, km: coarseDistance(out.km), miles: coarseDistance(out.miles) }
    : out;
}

/** `find_nearby`: closest first, within reach, at most `limit`. */
export async function nearby(
  repo: SpotRepository,
  origin: ResolvedOrigin,
  q: Omit<NearbyQuery, 'origin'>,
): Promise<NearbySpot[]> {
  const views = findNearby(await repo.list(), {
    origin: origin.origin,
    maxMinutes: q.maxMinutes,
    kinds: q.kinds,
  });
  return views.slice(0, q.limit).map((v) => present(v, origin));
}

/** `roll`: one random spot within reach (never the previous pick if there's another). */
export async function rollSpot(
  repo: SpotRepository,
  origin: ResolvedOrigin,
  body: Omit<RollBody, 'origin'>,
  random: () => number = Math.random,
): Promise<NearbySpot | null> {
  const views = findNearby(await repo.list(), {
    origin: origin.origin,
    maxMinutes: body.maxMinutes,
    kinds: body.kinds,
  });
  const pick = roll(
    views.map((v) => ({ id: v.spot.id, v })),
    body.previousId ?? null,
    random,
  );
  return pick ? present(pick.v, origin) : null;
}

// ---------------------------------------------------------------------------
// add_spot, all three ways

export type AddRequest =
  | { form: 'manual'; input: AddSpot }
  | { form: 'apple'; input: AddApplePlace }
  /** A place already in `places`, by its id (a shared link). */
  | { form: 'place'; input: AddSharedPlace }
  /** `near`: already resolved (see resolveSearchCentre); a query add always has one. */
  | { form: 'query'; input: AddByQuery; near: LatLng };

export interface AddResult {
  spot: Spot;
  /** false when it was already on your list: nothing changed, that entry comes back. */
  created: boolean;
  resolvedFrom: 'manual' | 'apple' | 'place';
  /** add_spot with `query`: the runners-up, in case the match was the wrong one. */
  alternatives?: ApplePlace[];
}

/** add_spot with `query` found no clear match. Nothing was added; these are the options. */
export class AmbiguousMatch extends Error {
  readonly candidates: ApplePlace[];
  constructor(candidates: ApplePlace[]) {
    super('several places could be that one: pick one and add it by applePlaceId');
    this.name = 'AmbiguousMatch';
    this.candidates = candidates;
  }
}

/** How many candidates an ambiguous answer lists. */
export const AMBIGUOUS_CANDIDATES = 5;

// scripts written without spaces between words: match the query as a run of text
const NO_SPACES =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Does a place's name say what the words say? Accents, case and punctuation
 * aside, every query word must be a whole word of the name ("the bar" ->
 * "The Bar", but "bar" is not "Barista Cafe"). For CJK and other scripts
 * written without spaces, the whole query must appear in the name
 * ("拉面" -> "一乐拉面馆").
 */
export function nameMatches(query: string, name: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return false;
  const n = normalizeSearch(name);
  if (NO_SPACES.test(q)) return n.replaceAll(' ', '').includes(q.replaceAll(' ', ''));
  const words = new Set(n.split(' '));
  return q.split(' ').every((w) => words.has(w));
}

/**
 * The place a free-text `add_spot` should add, or null if it isn't clear:
 * Apple's top result when its name matches the words (see nameMatches), or
 * the only result. "noodles" matching ten restaurants, or "bar" matching
 * "Barista Cafe" first, is not a choice to make for someone.
 */
export function confidentMatch(query: string, results: readonly ApplePlace[]): ApplePlace | null {
  const [top] = results;
  if (!top) return null;
  if (nameMatches(query, top.name)) return top;
  return results.length === 1 ? top : null;
}

/**
 * Shared `places` rows are always resolved in English, whoever adds the
 * place first, so everyone who saves it sees the same name and address.
 * (Per-language names would be their own table, later.)
 */
const PLACE_LANG = 'en';

/**
 * `add_spot`. By hand: as given. With an Apple Place ID: name, location and
 * address come from Apple (or from the shared `places` row, if anyone saved
 * it before). With a `query`: Apple Maps is searched around `near`, and the
 * match is added only if confidentMatch says it's clear (else AmbiguousMatch).
 */
export async function addSpot(
  repo: D1SpotRepository,
  maps: AppleMaps,
  req: AddRequest,
): Promise<AddResult> {
  if (req.form === 'manual')
    return { spot: await repo.add(req.input), created: true, resolvedFrom: 'manual' };

  if (req.form === 'place') {
    const { placeId, ...extras } = req.input;
    return { ...(await repo.addSharedPlace(placeId, extras)), resolvedFrom: 'place' };
  }

  if (req.form === 'apple') {
    const { applePlaceId, ...extras } = req.input;
    const added = await repo.addApplePlace(applePlaceId, extras, () =>
      maps.place(applePlaceId, PLACE_LANG),
    );
    return { ...added, resolvedFrom: 'apple' };
  }

  // `near` is already resolved into req.near; spotFromInput reads only the spot's own fields
  const { query, ...extras } = req.input;
  const results = await maps.search({ q: query, lang: PLACE_LANG, near: req.near });
  if (!results.length) throw new SpotOpError('no_match', 'nothing on Apple Maps matches that');
  const match = confidentMatch(query, results);
  if (!match) throw new AmbiguousMatch(results.slice(0, AMBIGUOUS_CANDIDATES));
  const added = await repo.addApplePlace(
    match.applePlaceId,
    { ...extras, kind: extras.kind ?? match.kind },
    () => Promise.resolve(match),
  );
  return {
    ...added,
    resolvedFrom: 'apple',
    alternatives: results.filter((p) => p !== match).slice(0, 2),
  };
}

/**
 * Where an Apple Maps search is centred: explicit coordinates, your saved
 * home ('home'; an error if there's none), or with nothing given your home
 * if you saved one, else nowhere in particular.
 */
export async function resolveSearchCentre(
  db: D1Database,
  userId: string,
  near: Origin | undefined,
  /** Your home if it was already read (prefetched with the session); undefined: not read yet. */
  knownHome?: LatLng | null,
  /** An agent is asking: search around home's grid cell, not home. */
  { coarse = false }: { coarse?: boolean } = {},
): Promise<{ ok: true; near: LatLng | undefined } | { ok: false }> {
  if (near !== undefined && near !== 'home') return { ok: true, near };
  const home = knownHome === undefined ? await getHome(db, userId) : knownHome;
  if (near === 'home' && !home) return { ok: false };
  return { ok: true, near: home ? (coarse ? snapToGrid(home) : home) : undefined };
}
