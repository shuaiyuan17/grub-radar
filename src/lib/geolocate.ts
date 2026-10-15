import type { LatLng } from '../domain/geo';

const GEO_TIMEOUT_MS = 10_000;

/** One browser location lookup. Calls exactly one of the callbacks. */
export function locate(
  onOk: (p: LatLng) => void,
  onFail: (reason: 'denied' | 'unavailable') => void,
): void {
  if (!('geolocation' in navigator)) {
    onFail('unavailable');
    return;
  }
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      onOk({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    },
    (err) => {
      onFail(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
    },
    { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
  );
}
