import type { LatLng } from './domain/geo';

/** Demo origin: downtown Seattle. Public and deliberately generic. */
export const DEMO_HOME: LatLng = { lat: 47.6101, lng: -122.3344 };

/**
 * Parses `VITE_HOME` ("lat,lng"). Falls back to the demo origin when unset or
 * malformed, so a bad value never breaks the app.
 */
export function parseHome(raw: string | undefined): LatLng {
  if (!raw) return DEMO_HOME;
  const parts = raw.split(',').map((p) => Number(p.trim()));
  const [lat, lng] = parts;
  if (
    parts.length !== 2 ||
    lat === undefined ||
    lng === undefined ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    Math.abs(lat) > 90 ||
    Math.abs(lng) > 180
  ) {
    console.warn(
      `VITE_HOME should look like "47.61,-122.33"; got "${raw}". Using the demo origin.`,
    );
    return DEMO_HOME;
  }
  return { lat, lng };
}

export const HOME: LatLng = parseHome(import.meta.env.VITE_HOME);
