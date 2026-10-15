import { createContext, use } from 'react';
import type { LatLng } from '../domain/geo';
import type { NoticeKey } from '../i18n/messages';

export type From = 'home' | 'here';
export type LocateStatus = 'idle' | 'locating' | 'ok' | 'denied' | 'unavailable';

export interface OriginValue {
  from: From;
  origin: LatLng;
  status: LocateStatus;
  /** What to tell the user (a message key; the UI translates it). */
  notice: NoticeKey | null;
  chooseHome: () => void;
  chooseHere: () => void;
  dismissNotice: () => void;

  /** The home origin in use: yours (saved on this device) or the demo one. */
  home: LatLng;
  homeIsDemo: boolean;
  homeEditorOpen: boolean;
  openHomeEditor: () => void;
  closeHomeEditor: () => void;
  /**
   * Validates and uses `home`, saving it to this device. Returns false if it
   * was invalid or couldn't be stored (then it's used for this visit only).
   * Cancels any pending setHomeFromHere().
   */
  setHome: (home: LatLng) => boolean;
  /** Asks the browser where you are and saves that as home. */
  setHomeFromHere: () => void;
  forgetHome: () => void;
}

export const OriginContext = createContext<OriginValue | null>(null);

export function useOrigin(): OriginValue {
  const ctx = use(OriginContext);
  if (!ctx) throw new Error('useOrigin must be used inside <OriginProvider>');
  return ctx;
}
