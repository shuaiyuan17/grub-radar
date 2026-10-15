import { createContext, use } from 'react';
import type { LatLng } from '../domain/geo';

export type From = 'home' | 'here';
export type LocateStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable';

export interface OriginValue {
  from: From;
  origin: LatLng;
  status: LocateStatus;
  /** Human-readable reason when we fell back to home. */
  notice: string | null;
  chooseHome: () => void;
  chooseHere: () => void;
  dismissNotice: () => void;
}

export const OriginContext = createContext<OriginValue | null>(null);

export function useOrigin(): OriginValue {
  const ctx = use(OriginContext);
  if (!ctx) throw new Error('useOrigin must be used inside <OriginProvider>');
  return ctx;
}
