import type { LatLng } from './geo';
import type { TravelMode } from './travel';

/**
 * Apple Maps directions deep link. Opens the Maps app on Apple devices and
 * maps.apple.com elsewhere. The start point is left to Maps (your current
 * location), which is what you want when you're actually heading out.
 */
export function appleMapsUrl(name: string, to: LatLng, mode: TravelMode): string {
  const dirflg = mode === 'walk' ? 'w' : 'd';
  return `https://maps.apple.com/?daddr=${to.lat},${to.lng}&q=${encodeURIComponent(name)}&dirflg=${dirflg}`;
}

export function mapsLabel(spot: { name: string }, travel: { mode: TravelMode }): string {
  const how = travel.mode === 'walk' ? 'walking' : 'driving';
  return `Take me to ${spot.name}: ${how} directions in Apple Maps`;
}
