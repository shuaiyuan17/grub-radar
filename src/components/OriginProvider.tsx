import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_HOME } from '../config';
import { isLatLng, type LatLng } from '../domain/geo';
import { locate } from '../lib/geolocate';
import { clearHome, loadHome } from '../lib/home';
import type { HomeClient } from '../lib/homeClient';
import type { NoticeKey } from '../i18n/messages';
import { OriginContext, type From, type LocateStatus, type OriginValue } from '../lib/origin';

/**
 * Where distances are measured from: home (saved to your account) or where
 * you are right now. Home starts as the server's (`initialHome`, from GET
 * /api/me); every change is saved through `client` and reported via
 * `onSaved` so the signed-in state stays in sync.
 *
 * One-time migration: v0 kept home in this browser's localStorage. If the
 * account has no home yet and this device has one, it's moved to the
 * account and removed from the device.
 */
export function OriginProvider({
  children,
  initialHome,
  client,
  onSaved,
}: {
  children: ReactNode;
  initialHome: LatLng | null;
  client: HomeClient;
  onSaved?: (home: LatLng | null) => void;
}) {
  // no home on the account yet: an old device home (v0) is used right away, and moved below
  const [saved, setSaved] = useState<LatLng | null>(() => initialHome ?? loadHome());
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
  // bumped by every home write, so only the latest one's answer shows a notice
  const homeWrite = useRef(0);

  const persist = useCallback(
    (home: LatLng | null, ok: NoticeKey) => {
      const id = (homeWrite.current += 1);
      (home ? client.save(home) : client.clear()).then(
        () => {
          if (home === null) clearHome(); // tidy up any v0 copy on this device too
          onSaved?.(home);
          if (id === homeWrite.current) setNotice(ok);
        },
        () => {
          if (id === homeWrite.current) setNotice('homeSyncFailed');
        },
      );
    },
    [client, onSaved],
  );

  // the v0 -> account move, once per mount (StrictMode runs effects twice)
  const migrated = useRef(false);
  useEffect(() => {
    if (migrated.current || initialHome !== null) return;
    migrated.current = true;
    const local = loadHome();
    if (!local) return;
    const id = (homeWrite.current += 1);
    client.save(local).then(
      () => {
        clearHome();
        onSaved?.(local);
        if (id === homeWrite.current) setNotice('homeMoved');
      },
      () => undefined, // keep it on this device; try again next visit
    );
  }, [client, initialHome, onSaved]);
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

  /** Uses a home right away and saves it to your account. False if it isn't a valid point. */
  const applyHome = useCallback(
    (home: LatLng) => {
      if (!isLatLng(home)) return false;
      setSaved({ lat: home.lat, lng: home.lng });
      setNotice(null);
      setHomeEditorOpen(false);
      persist({ lat: home.lat, lng: home.lng }, 'homeSaved');
      return true;
    },
    [persist],
  );

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
    setSaved(null);
    setHomeEditorOpen(false);
    persist(null, 'homeForgotten');
  }, [cancelHomeLocate, persist]);

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
