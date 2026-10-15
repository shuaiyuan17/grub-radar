/** A point on the globe, in decimal degrees. */
export interface LatLng {
  lat: number;
  lng: number;
}

/** Mean Earth radius (IUGG), km. */
export const EARTH_RADIUS_KM = 6371.0088;
export const KM_PER_MILE = 1.609344;

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle ("as the crow flies") distance in km, via the haversine formula. */
export function distanceKm(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial compass bearing from a to b, degrees in [0, 360). 0 = north, 90 = east. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export const kmToMiles = (km: number) => km / KM_PER_MILE;

const inRange = (lat: number, lng: number) =>
  Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** Type guard for anything that claims to be a LatLng (e.g. from storage). */
export function isLatLng(value: unknown): value is LatLng {
  if (typeof value !== 'object' || value === null) return false;
  const { lat, lng } = value as Record<string, unknown>;
  return typeof lat === 'number' && typeof lng === 'number' && inRange(lat, lng);
}

/**
 * Parses "47.61, -122.33" (comma and/or spaces between). Strict: exactly two
 * non-empty numbers, finite, latitude within ±90 and longitude within ±180.
 * Returns null otherwise ("47.61," is not lng 0).
 */
export function parseLatLng(raw: string): LatLng | null {
  const parts = raw.trim().split(/\s*,\s*|\s+/);
  if (parts.length !== 2) return null;
  const [a, b] = parts;
  const numeric = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
  if (!a || !b || !numeric.test(a) || !numeric.test(b)) return null;
  const lat = Number(a);
  const lng = Number(b);
  return inRange(lat, lng) ? { lat, lng } : null;
}
