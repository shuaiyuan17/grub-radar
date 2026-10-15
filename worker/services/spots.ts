/**
 * The spot operations behind both doors: REST routes call these now, the MCP
 * tools (PR 6) will be thin adapters over the same functions. Each takes the
 * repository for the calling principal's user, so scoping is decided once,
 * when the repository is built.
 */
import type { AddApplePlace, AddByQuery, ApplePlace } from '../../src/contracts/places';
import type { NearbyQuery, Origin, RollBody } from '../../src/contracts/spots';
import { SpotOpError, type AddSpot } from '../../src/domain/edits';
import type { LatLng } from '../../src/domain/geo';
import { findNearby, toNearbySpot, type NearbySpot } from '../../src/domain/nearby';
import type { SpotRepository } from '../../src/domain/repository';
import { normalizeSearch } from '../../src/domain/modes';
import { roll } from '../../src/domain/roll';
import type { Spot } from '../../src/domain/spot';
import type { D1SpotRepository } from '../db/spots';
import { getHome } from '../db/users';
import type { AppleMaps } from './appleMaps';

export type OriginResult = { ok: true; origin: LatLng; isHome: boolean } | { ok: false };

/** 'home' becomes the saved home (never echoed back); coordinates pass through. */
export async function resolveOrigin(
  db: D1Database,
  userId: string,
  origin: Origin,
): Promise<OriginResult> {
  if (origin !== 'home') return { ok: true, origin, isHome: false };
  const home = await getHome(db, userId);
  return home ? { ok: true, origin: home, isHome: true } : { ok: false };
}

/** `find_nearby`: closest first, within reach, at most `limit`. */
export async function nearby(
  repo: SpotRepository,
  origin: { origin: LatLng; isHome: boolean },
  q: Omit<NearbyQuery, 'origin'>,
): Promise<NearbySpot[]> {
  const views = findNearby(await repo.list(), {
    origin: origin.origin,
    maxMinutes: q.maxMinutes,
    kinds: q.kinds,
  });
  return views.slice(0, q.limit).map((v) => toNearbySpot(v, !origin.isHome));
}

/** `roll`: one random spot within reach (never the previous pick if there's another). */
export async function rollSpot(
  repo: SpotRepository,
  origin: { origin: LatLng; isHome: boolean },
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
  return pick ? toNearbySpot(pick.v, !origin.isHome) : null;
}

// ---------------------------------------------------------------------------
// add_spot, all three ways

export type AddRequest =
  | { form: 'manual'; input: AddSpot }
  | { form: 'apple'; input: AddApplePlace }
  /** `near`: already resolved (see resolveSearchCentre); a query add always has one. */
  | { form: 'query'; input: AddByQuery; near: LatLng };

export interface AddResult {
  spot: Spot;
  /** false when it was already on your list: nothing changed, that entry comes back. */
  created: boolean;
  resolvedFrom: 'manual' | 'apple';
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

/**
 * The place a free-text `add_spot` should add, or null if it isn't clear:
 * Apple's top result when its name contains the words (accents, case and
 * punctuation aside: "serious pie" -> "Serious Pie"), or when it's the only
 * result. "noodles" matching ten restaurants is not a choice to make for
 * someone.
 */
export function confidentMatch(query: string, results: readonly ApplePlace[]): ApplePlace | null {
  const [top] = results;
  if (!top) return null;
  const words = normalizeSearch(query);
  if (words && normalizeSearch(top.name).includes(words)) return top;
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
): Promise<{ ok: true; near: LatLng | undefined } | { ok: false }> {
  if (near !== undefined && near !== 'home') return { ok: true, near };
  const home = knownHome === undefined ? await getHome(db, userId) : knownHome;
  if (near === 'home' && !home) return { ok: false };
  return { ok: true, near: home ?? undefined };
}
