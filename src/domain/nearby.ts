import type { LatLng } from './geo';
import { KINDS, type Kind, type Spot } from './spot';
import { byDistance, toSpotViews, type SpotView } from './spotView';

export interface FindNearbyQuery {
  origin: LatLng;
  /** Inclusive. Omit for "anywhere". */
  maxMinutes?: number;
  /** Omit for every kind. */
  kinds?: readonly Kind[];
}

/**
 * Spots reachable from `origin` within `maxMinutes` (estimated travel time),
 * closest first by distance.
 * The future `find_nearby` tool is this function over repository.list().
 */
export function findNearby(
  spots: readonly Spot[],
  { origin, maxMinutes = Infinity, kinds = KINDS }: FindNearbyQuery,
): SpotView[] {
  return toSpotViews(spots, origin)
    .filter((v) => kinds.includes(v.spot.kind) && v.travel.minutes <= maxMinutes)
    .sort(byDistance);
}
