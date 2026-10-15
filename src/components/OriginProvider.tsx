import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react';
import { HOME } from '../config';
import type { LatLng } from '../domain/geo';
import { OriginContext, type From, type LocateStatus, type OriginValue } from '../lib/origin';

const GEO_TIMEOUT_MS = 10_000;

const messages: Record<'denied' | 'unavailable', string> = {
  denied: "location is blocked for this site, so we're measuring from home.",
  unavailable: "couldn't find you just now, so we're measuring from home.",
};

export function OriginProvider({ children, home = HOME }: { children: ReactNode; home?: LatLng }) {
  const [from, setFrom] = useState<From>('home');
  const [here, setHere] = useState<LatLng | null>(null);
  const [status, setStatus] = useState<LocateStatus>('idle');
  const [notice, setNotice] = useState<string | null>(null);
  const request = useRef(0);

  const fallBack = useCallback((reason: 'denied' | 'unavailable') => {
    setFrom('home');
    setStatus(reason);
    setNotice(messages[reason]);
  }, []);

  const chooseHome = useCallback(() => {
    request.current += 1; // ignore any in-flight lookup
    setFrom('home');
    setStatus('idle');
    setNotice(null);
  }, []);

  const chooseHere = useCallback(() => {
    if (!('geolocation' in navigator)) {
      fallBack('unavailable');
      return;
    }
    const id = (request.current += 1);
    setStatus('locating');
    setNotice(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (id !== request.current) return;
        setHere({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setFrom('here');
        setStatus('ok');
      },
      (err) => {
        if (id !== request.current) return;
        fallBack(err.code === err.PERMISSION_DENIED ? 'denied' : 'unavailable');
      },
      { enableHighAccuracy: false, timeout: GEO_TIMEOUT_MS, maximumAge: 60_000 },
    );
  }, [fallBack]);

  const dismissNotice = useCallback(() => {
    setNotice(null);
  }, []);

  const value = useMemo<OriginValue>(
    () => ({
      from,
      origin: from === 'here' && here ? here : home,
      status,
      notice,
      chooseHome,
      chooseHere,
      dismissNotice,
    }),
    [from, here, home, status, notice, chooseHome, chooseHere, dismissNotice],
  );

  return <OriginContext value={value}>{children}</OriginContext>;
}
