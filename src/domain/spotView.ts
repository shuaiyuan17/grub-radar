import type { Spot } from './spot';
import type { LatLng } from './geo';
import { bearingDeg } from './geo';
import { estimateTravel, formatMinutes, ringFor, type Ring, type TravelEstimate } from './travel';

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

/** Closest first; ties broken by name so the order is stable. */
export function byTravelTime(a: SpotView, b: SpotView): number {
  return a.travel.minutes - b.travel.minutes || a.spot.name.localeCompare(b.spot.name);
}

/** Accessible name for a radar dot: "Ondo Soup House, food, 8 min drive". */
export function describeDot(v: SpotView, inReach: boolean): string {
  const base = `${v.spot.name}, ${v.spot.kind}, ${formatMinutes(v.travel.minutes)} ${v.travel.mode}`;
  return inReach ? base : `${base}, beyond your reach`;
}
