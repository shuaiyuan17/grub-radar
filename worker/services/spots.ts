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
  /** `near`: already resolved (see resolveSearchCentre). */
  | { form: 'query'; input: AddByQuery; near: LatLng | undefined };

export interface AddResult {
  spot: Spot;
  /** false when it was already on your list: nothing changed, that entry comes back. */
  created: boolean;
  resolvedFrom: 'manual' | 'apple';
  /** add_spot with `query`: the next-best Apple matches, in case the top one was wrong. */
  alternatives?: ApplePlace[];
}

/**
 * `add_spot`. By hand: as given. With an Apple Place ID: name, location and
 * address come from Apple (or from the shared `places` row, if anyone saved
 * it before). With a `query`: Apple Maps is searched around `near` and the
 * best match is added, the next two come back as alternatives.
 */
export async function addSpot(
  repo: D1SpotRepository,
  maps: AppleMaps,
  req: AddRequest,
): Promise<AddResult> {
  if (req.form === 'manual')
    return { spot: await repo.add(req.input), created: true, resolvedFrom: 'manual' };

  if (req.form === 'apple') {
    const { applePlaceId, lang, ...extras } = req.input;
    const added = await repo.addApplePlace(applePlaceId, extras, () =>
      maps.place(applePlaceId, lang ?? 'en'),
    );
    return { ...added, resolvedFrom: 'apple' };
  }

  // `near` is already resolved into req.near; spotFromInput reads only the spot's own fields
  const { query, lang, ...extras } = req.input;
  const [top, ...rest] = await maps.search({
    q: query,
    lang: lang ?? 'en',
    ...(req.near ? { near: req.near } : {}),
  });
  if (!top) throw new SpotOpError('no_match', 'nothing on Apple Maps matches that');
  const added = await repo.addApplePlace(
    top.applePlaceId,
    { ...extras, kind: extras.kind ?? top.kind },
    () => Promise.resolve(top),
  );
  return { ...added, resolvedFrom: 'apple', alternatives: rest.slice(0, 2) };
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
): Promise<{ ok: true; near: LatLng | undefined } | { ok: false }> {
  if (near === undefined) return { ok: true, near: (await getHome(db, userId)) ?? undefined };
  const origin = await resolveOrigin(db, userId, near);
  return origin.ok ? { ok: true, near: origin.origin } : { ok: false };
}
