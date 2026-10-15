import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_HOME } from '../config';
import { isLatLng, type LatLng } from '../domain/geo';
import { clearHome, loadHome, saveHome } from '../lib/home';
import type { NoticeKey } from '../i18n/messages';
import { OriginContext, type From, type LocateStatus, type OriginValue } from '../lib/origin';

const GEO_TIMEOUT_MS = 10_000;

function locate(
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

export function OriginProvider({ children }: { children: ReactNode }) {
  const [saved, setSaved] = useState<LatLng | null>(() => loadHome());
  const [from, setFrom] = useState<From>('home');
  const [here, setHere] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<LocateStatus>('idle');
  const [notice, setNotice] = useState<NoticeKey | null>(null);
  const [homeEditorOpen, setHomeEditorOpen] = useState(false);
  const request = useRef(0);
  // separate counter for "set home from where i am": anything that sets or
  // forgets home bumps it, so a late geolocation answer can't overwrite it
  const homeRequest = useRef(0);
  const homeLocating = useRef(false);
  const cancelHomeLocate = useCallback(() => {
    homeRequest.current += 1;
    if (homeLocating.current) {
      homeLocating.current = false;
      setStatus('idle');
    }
  }, []);

  const chooseHome = useCallback(() => {
    request.current += 1; // ignore any in-flight lookup
    setFrom('home');
    setStatus('idle');
    setNotice(null);
  }, []);

  const chooseHere = useCallback(() => {
    const id = (request.current += 1);
    setStatus('locating');
    setNotice(null);
    locate(
      (p) => {
        if (id !== request.current) return;
        setHere(p);
        setFrom('here');
        setStatus('ok');
      },
      (reason) => {
        if (id !== request.current) return;
        setFrom('home');
        setStatus(reason);
        setNotice(reason);
      },
    );
  }, []);

  /** Applies a home. Returns false if it couldn't be stored (still used for this visit). */
  const applyHome = useCallback((home: LatLng) => {
    if (!isLatLng(home)) return false;
    const stored = saveHome(home);
    setSaved(home);
    setNotice(stored ? 'homeSaved' : 'homeVisitOnly');
    setHomeEditorOpen(false);
    return stored;
  }, []);

  const setHome = useCallback(
    (home: LatLng) => {
      cancelHomeLocate(); // a typed home wins over a pending "use where i am now"
      return applyHome(home);
    },
    [applyHome, cancelHomeLocate],
  );

  const setHomeFromHere = useCallback(() => {
    const id = (homeRequest.current += 1);
    homeLocating.current = true;
    setStatus('locating');
    locate(
      (p) => {
        if (id !== homeRequest.current) return; // superseded: typed home, forget, newer request
        homeLocating.current = false;
        setStatus('idle');
        applyHome(p);
      },
      (reason) => {
        if (id !== homeRequest.current) return;
        homeLocating.current = false;
        setStatus('idle');
        setNotice(reason === 'denied' ? 'homeDenied' : 'homeUnavailable');
      },
    );
  }, [applyHome]);

  const forgetHome = useCallback(() => {
    cancelHomeLocate();
    clearHome();
    setSaved(null);
    setHomeEditorOpen(false);
  }, [cancelHomeLocate]);

  const value = useMemo<OriginValue>(() => {
    const home = saved ?? DEMO_HOME;
    return {
      from,
      origin: from === 'here' && here ? here : home,
      status,
      notice,
      chooseHome,
      chooseHere,
      dismissNotice: () => {
        setNotice(null);
      },
      home,
      homeIsDemo: saved === null,
      homeEditorOpen,
      openHomeEditor: () => {
        setHomeEditorOpen(true);
      },
      closeHomeEditor: () => {
        setHomeEditorOpen(false);
      },
      setHome,
      setHomeFromHere,
      forgetHome,
    };
  }, [
    saved,
    from,
    here,
    status,
    notice,
    homeEditorOpen,
    chooseHome,
    chooseHere,
    setHome,
    setHomeFromHere,
    forgetHome,
  ]);

  return <OriginContext value={value}>{children}</OriginContext>;
}
