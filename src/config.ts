import type { LatLng } from './domain/geo';

/**
 * Demo origin: downtown Seattle. Public and deliberately generic. Your real
 * home is never in the code or the build: it's saved on your device
 * (localStorage) from the "set home" panel. See lib/home.ts.
 */
export const DEMO_HOME: LatLng = { lat: 47.6101, lng: -122.3344 };
