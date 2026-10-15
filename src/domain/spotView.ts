import type { Spot } from './spot';
import type { LatLng } from './geo';
import { bearingDeg } from './geo';
import { estimateTravel, ringFor, type Ring, type TravelEstimate } from './travel';

/** A spot plus everything that depends on where you're measuring from. */
export interface SpotView {
  spot: Spot;
  travel: TravelEstimate;
  ring: Ring;
  bearing: number;
}

export function toSpotViews(spots: readonly Spot[], origin: LatLng): SpotView[] {
  return spots.map((spot) => {
    const travel = estimateTravel(origin, spot.location);
    return {
      spot,
      travel,
      ring: ringFor(travel.minutes),
      bearing: bearingDeg(origin, spot.location),
    };
  });
}

/**
 * Closest first, by actual distance; ties broken by name so the order is
 * stable. This is what "closest first" means in the list: a 14-minute walk
 * that's 0.9 km away comes before an 8-minute drive that's 1.6 km away.
 */
export function byDistance(a: SpotView, b: SpotView): number {
  return a.travel.km - b.travel.km || a.spot.name.localeCompare(b.spot.name);
}

/** Quickest first (the radar's ring order); ties broken by name. */
export function byTravelTime(a: SpotView, b: SpotView): number {
  return a.travel.minutes - b.travel.minutes || a.spot.name.localeCompare(b.spot.name);
}
