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

/**
 * One `find_nearby` / `roll` result, flat and small (what an agent reads).
 * `location` is left out when the origin was your home: a spot's coordinates
 * plus its distance from home, over a few spots, would give home away.
 */
export interface NearbySpot {
  id: string;
  name: string;
  kind: Kind;
  cuisine?: string;
  status: Spot['status'];
  rating?: number;
  note?: string;
  tags: string[];
  minutes: number;
  mode: SpotView['travel']['mode'];
  /** Rounded to 0.1. */
  km: number;
  miles: number;
  ring: SpotView['ring'];
  location?: Spot['location'];
}

const tenth = (n: number) => Math.round(n * 10) / 10;

export function toNearbySpot(view: SpotView, withLocation: boolean): NearbySpot {
  const { spot, travel, ring } = view;
  const out: NearbySpot = {
    id: spot.id,
    name: spot.name,
    kind: spot.kind,
    status: spot.status,
    tags: spot.tags,
    minutes: travel.minutes,
    mode: travel.mode,
    km: tenth(travel.km),
    miles: tenth(travel.miles),
    ring,
  };
  if (spot.cuisine !== undefined) out.cuisine = spot.cuisine;
  if (spot.rating !== undefined) out.rating = spot.rating;
  if (spot.note !== undefined) out.note = spot.note;
  if (withLocation) out.location = spot.location;
  return out;
}
