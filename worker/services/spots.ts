/**
 * The spot operations behind both doors: REST routes call these now, the MCP
 * tools (PR 6) will be thin adapters over the same functions. Each takes the
 * repository for the calling principal's user, so scoping is decided once,
 * when the repository is built.
 */
import type { NearbyQuery, Origin, RollBody } from '../../src/contracts/spots';
import type { LatLng } from '../../src/domain/geo';
import { findNearby, toNearbySpot, type NearbySpot } from '../../src/domain/nearby';
import type { SpotRepository } from '../../src/domain/repository';
import { roll } from '../../src/domain/roll';
import { getHome } from '../db/users';

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
