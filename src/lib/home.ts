import { isLatLng, type LatLng } from '../domain/geo';

/**
 * v0 kept home on the device (localStorage). Since v1 it lives in your
 * account; this is only read once, to move an old device home there
 * (OriginProvider), and cleared afterwards.
 */
export const HOME_KEY = 'grub-radar:home';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // e.g. storage disabled
  }
}

/** The saved home, or null if none / unreadable / invalid. */
export function loadHome(store: Storage | null = storage()): LatLng | null {
  try {
    const raw = store?.getItem(HOME_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    return isLatLng(value) ? { lat: value.lat, lng: value.lng } : null;
  } catch {
    return null;
  }
}

/** Saves a validated home. Returns false if it couldn't be stored. */
export function saveHome(home: LatLng, store: Storage | null = storage()): boolean {
  if (!isLatLng(home) || !store) return false;
  try {
    store.setItem(HOME_KEY, JSON.stringify({ lat: home.lat, lng: home.lng }));
    return true;
  } catch {
    return false;
  }
}

export function clearHome(store: Storage | null = storage()): void {
  try {
    store?.removeItem(HOME_KEY);
  } catch {
    // nothing to do
  }
}
