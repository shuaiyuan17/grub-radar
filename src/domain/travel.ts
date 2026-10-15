import { distanceKm, kmToMiles, type LatLng } from './geo';

/**
 * Travel-time heuristic. No routing API, no keys: we take the great-circle
 * distance, inflate it to approximate real streets, then pick walking or
 * driving.
 *
 *   street km  = crow-flies km × DETOUR_FACTOR
 *   walk min   = street km ÷ WALK_KMH × 60
 *   if walk min ≤ MAX_WALK_MINUTES → walk
 *   else drive min = DRIVE_OVERHEAD_MINUTES
 *                  + first CITY_KM of street km at CITY_KMH
 *                  + the rest at HIGHWAY_KMH
 *
 * Tweak the constants here; tests pin the behaviour around each threshold.
 */
export const DETOUR_FACTOR = 1.3;
export const WALK_KMH = 4.8;
export const MAX_WALK_MINUTES = 20;
/** Walking to the car, parking, the last block on foot. */
export const DRIVE_OVERHEAD_MINUTES = 4;
export const CITY_KM = 8;
export const CITY_KMH = 30;
export const HIGHWAY_KMH = 80;

export type TravelMode = 'walk' | 'drive';

export interface TravelEstimate {
  mode: TravelMode;
  /** Whole minutes, at least 1. */
  minutes: number;
  /** Great-circle distance. */
  km: number;
  miles: number;
}

export function walkMinutes(crowKm: number): number {
  return ((crowKm * DETOUR_FACTOR) / WALK_KMH) * 60;
}

export function driveMinutes(crowKm: number): number {
  const streetKm = crowKm * DETOUR_FACTOR;
  const cityKm = Math.min(streetKm, CITY_KM);
  const highwayKm = Math.max(0, streetKm - CITY_KM);
  return DRIVE_OVERHEAD_MINUTES + (cityKm / CITY_KMH) * 60 + (highwayKm / HIGHWAY_KMH) * 60;
}

/** Walk if it takes MAX_WALK_MINUTES or less (inclusive), otherwise drive. */
export function chooseMode(walkMin: number): TravelMode {
  return walkMin <= MAX_WALK_MINUTES ? 'walk' : 'drive';
}

export function estimateFromKm(crowKm: number): TravelEstimate {
  const km = Math.max(0, crowKm);
  const walk = walkMinutes(km);
  const mode = chooseMode(walk);
  const raw = mode === 'walk' ? walk : driveMinutes(km);
  return { mode, minutes: Math.max(1, Math.round(raw)), km, miles: kmToMiles(km) };
}

export function estimateTravel(from: LatLng, to: LatLng): TravelEstimate {
  return estimateFromKm(distanceKm(from, to));
}

/** Upper bound (inclusive, minutes) of each radar ring; anything beyond is a road trip. */
export const RING_LIMITS = [10, 30, 60] as const;
export type Ring = 0 | 1 | 2 | 3;
export const MAX_RING: Ring = 3;

export function ringFor(minutes: number): Ring {
  if (minutes <= RING_LIMITS[0]) return 0;
  if (minutes <= RING_LIMITS[1]) return 1;
  if (minutes <= RING_LIMITS[2]) return 2;
  return 3;
}

export function isRing(n: number): n is Ring {
  return n === 0 || n === 1 || n === 2 || n === 3;
}

/** "8 min", "1h", "1h 10". */
export function formatMinutes(minutes: number): string {
  const m = Math.max(1, Math.round(minutes));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest === 0 ? `${h}h` : `${h}h ${String(rest).padStart(2, '0')}`;
}

/** "0.4 mi", "7.0 mi", "36 mi". */
export function formatMiles(miles: number): string {
  return miles < 10 ? `${miles.toFixed(1)} mi` : `${Math.round(miles)} mi`;
}

/** The most minutes that still counts as "within" a ring. Road trip = no limit. */
export function maxMinutesForRing(ring: Ring): number {
  return ring === 3 ? Infinity : RING_LIMITS[ring];
}
