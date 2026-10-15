import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_HOME } from '../config';
import { isLatLng, type LatLng } from '../domain/geo';
import { clearHome, loadHome, saveHome } from '../lib/home';
import { OriginContext, type From, type LocateStatus, type OriginValue } from '../lib/origin';

const GEO_TIMEOUT_MS = 10_000;

const messages = {
  denied: "location is blocked for this site, so we're measuring from home.",
  unavailable: "couldn't find you just now, so we're measuring from home.",
  homeDenied: "location is blocked, so we couldn't set home from it. try typing it in.",
  homeUnavailable: "couldn't find you just now. try again, or type it in.",
  homeSaved: 'home saved on this device.',
} as const;

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
  const [notice, setNotice] = useState<string | null>(null);
  const [homeEditorOpen, setHomeEditorOpen] = useState(false);
  const request = useRef(0);

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
        setNotice(messages[reason]);
      },
    );
  }, []);

  const setHome = useCallback((home: LatLng) => {
    if (!isLatLng(home)) return false;
    saveHome(home); // best effort: still use it for this visit if storage is off
    setSaved(home);
    setNotice(messages.homeSaved);
    setHomeEditorOpen(false);
    return true;
  }, []);

  const setHomeFromHere = useCallback(() => {
    setStatus('locating');
    locate(
      (p) => {
        setStatus('idle');
        setHome(p);
      },
      (reason) => {
        setStatus('idle');
        setNotice(reason === 'denied' ? messages.homeDenied : messages.homeUnavailable);
      },
    );
  }, [setHome]);

  const forgetHome = useCallback(() => {
    clearHome();
    setSaved(null);
    setHomeEditorOpen(false);
  }, []);

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
