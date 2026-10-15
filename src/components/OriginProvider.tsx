import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DEMO_HOME } from '../config';
import { isLatLng, type LatLng } from '../domain/geo';
import { locate } from '../lib/geolocate';
import { clearDeviceHome, homeIsDeviceOnly, loadHome, setHomeDeviceOnly } from '../lib/home';
import type { HomeClient } from '../lib/homeClient';
import type { NoticeKey } from '../i18n/messages';
import { OriginContext, type From, type LocateStatus, type OriginValue } from '../lib/origin';

/**
 * Where distances are measured from: home (saved to your account) or where
 * you are right now. Home starts as the server's (`initialHome`, from GET
 * /api/me); every change is saved through `client` and reported via
 * `onSaved` so the signed-in state stays in sync.
 *
 * Home writes are serialized: one request at a time, and if you change home
 * again while one is in flight, the newest value is written next. So the
 * server always ends on your latest choice, and only that choice's outcome
 * is announced.
 *
 * v0 kept home in this browser's localStorage. If the account has no home
 * and this device has one, it's used here and you're asked once whether to
 * save it to the account ("keep it on this device only" is remembered). If
 * the account already has a home, the device copy is stale (the account
 * always wins), so it's cleared without asking.
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
  // no home on the account yet: an old device home (v0) is used right away
  const [device] = useState<LatLng | null>(() => (initialHome ? null : loadHome()));
  const [saved, setSaved] = useState<LatLng | null>(initialHome ?? device);
  const [consent, setConsent] = useState<LatLng | null>(() =>
    device && !homeIsDeviceOnly() ? device : null,
  );
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

  // the home write queue: the latest wanted value, and whether a write is running
  const wanted = useRef<{ seq: number; home: LatLng | null; ok: NoticeKey } | null>(null);
  const writing = useRef(false);

  const persist = useCallback(
    (home: LatLng | null, ok: NoticeKey) => {
      const seq = (wanted.current?.seq ?? 0) + 1;
      wanted.current = { seq, home, ok };
      if (writing.current) return; // the running loop picks this one up next
      writing.current = true;
      void (async () => {
        for (;;) {
          const job = wanted.current;
          if (!job) break;
          let ok = true;
          try {
            await (job.home ? client.save(job.home) : client.clear());
          } catch {
            ok = false;
          }
          if (wanted.current?.seq !== job.seq) continue; // superseded meanwhile: write the newer one
          if (ok) {
            clearDeviceHome(); // the account has it now
            onSaved?.(job.home);
          }
          setNotice(ok ? job.ok : 'homeSyncFailed');
          break;
        }
        writing.current = false;
      })();
    },
    [client, onSaved],
  );

  // second device: the account already has a home, so this device's old copy is stale
  useEffect(() => {
    if (initialHome && loadHome()) clearDeviceHome();
  }, [initialHome]);

  const acceptHomeConsent = useCallback(() => {
    if (!consent) return;
    setConsent(null);
    persist(consent, 'homeMoved');
  }, [consent, persist]);

  const declineHomeConsent = useCallback(() => {
    setConsent(null);
    setHomeDeviceOnly(true); // don't ask again on this device
  }, []);

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
      setConsent(null); // a new choice answers the old question
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
    setConsent(null);
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
      homeConsent: consent,
      acceptHomeConsent,
      declineHomeConsent,
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
    consent,
    acceptHomeConsent,
    declineHomeConsent,
    chooseHome,
    chooseHere,
    setHome,
    setHomeFromHere,
    forgetHome,
  ]);

  return <OriginContext value={value}>{children}</OriginContext>;
}
