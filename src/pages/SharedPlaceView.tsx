import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { SpotLabel } from '../components/bits';
import { FriendTakesBox } from '../components/FriendTakes';
import { Icon } from '../components/Icon';
import { Ink } from '../components/Ink';
import type { Photo } from '../contracts/photos';
import type { SharedPlaceResponse, SharedTake } from '../contracts/shared';
import type { LatLng } from '../domain/geo';
import { bearingDeg } from '../domain/geo';
import { appleMapsUrl } from '../domain/maps';
import type { Kind } from '../domain/spot';
import { estimateTravel, ringFor, type TravelEstimate } from '../domain/travel';
import { useT } from '../i18n/context';
import { saveErrorMessage } from '../lib/errors';
import { useFriendsClient } from '../lib/friends';
import { useOrigin } from '../lib/origin';
import { backTarget, fromFriend, splitName } from '../lib/placeNav';
import { RING_DIAMETERS, radiusFor } from '../lib/radar';
import { useSpots } from '../lib/spots';
import page from './PlacePage.module.css';
import styles from './SharedPlaceView.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: SharedPlaceResponse }
  | { state: 'missing' }
  | { state: 'error' };

/**
 * /place/:id for a place that isn't on your list: someone shared the link.
 * What the place is (from the shared `places` row), your friends' takes on
 * it (decided by the server: only your friends, only what they share), and
 * "add to my radar". Once it's added, PlacePage shows your own page instead.
 */
export function SharedPlaceView({ id, notFound }: { id: string; notFound: ReactNode }) {
  const client = useFriendsClient();
  const [load, setLoad] = useState<{ id: string; load: Load }>({ id, load: { state: 'loading' } });
  const current = load.id === id ? load.load : { state: 'loading' as const };

  useEffect(() => {
    let live = true;
    client.sharedPlace(id).then(
      (data) => {
        if (live) setLoad({ id, load: data ? { state: 'ready', data } : { state: 'missing' } });
      },
      () => {
        if (live) setLoad({ id, load: { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
  }, [client, id]);

  if (current.state === 'missing') return notFound;
  if (current.state === 'ready') return <Shared data={current.data} />;
  return <Pending error={current.state === 'error'} />;
}

function Pending({ error }: { error: boolean }) {
  const t = useT();
  return (
    <main id="main" className={`${page.main} ${page.notFound}`}>
      {error ? (
        <p role="alert" className="note" style={{ fontSize: 22 }}>
          {t.sharedPlace.loadFailed}
        </p>
      ) : (
        <p className="note" style={{ fontSize: 22 }} aria-busy="true">
          {t.loading}
        </p>
      )}
    </main>
  );
}

/** The kind to file it under: the friend you came from's, else the first friend's, else food. */
function kindFrom(takes: readonly SharedTake[], first: string | undefined): Kind {
  return (takes.find((k) => k.friend.id === first) ?? takes[0])?.kind ?? 'food';
}

function Shared({ data }: { data: SharedPlaceResponse }) {
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const { origin, from } = useOrigin();
  const { actions } = useSpots();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { place, friendsTakes } = data;
  const first = fromFriend(location.state);
  const back = backTarget(location.state);
  const travel = estimateTravel(origin, place.location);
  const [nameA, nameB] = splitName(place.name);
  const knownKind = friendsTakes.length > 0 ? kindFrom(friendsTakes, first) : null;
  const photos: Record<string, Photo[]> = Object.fromEntries(
    friendsTakes.map((k) => [k.friend.id, k.photos]),
  );
  const fromLabel = from === 'here' ? t.sharedPlace.fromHere : t.sharedPlace.fromHome;

  const add = async () => {
    if (!actions?.addSharedPlace || adding) return;
    setAdding(true);
    setError(null);
    try {
      await actions.addSharedPlace({
        placeId: place.id,
        kind: kindFrom(friendsTakes, first),
        status: 'want',
      });
      // it's on your list now: the same URL shows your own page, saying so once
      void navigate(location.pathname, {
        replace: true,
        state: { ...(location.state as object | null), added: true },
      });
    } catch (e) {
      setError(saveErrorMessage(e, t));
      setAdding(false);
    }
  };

  return (
    <main id="main" className={page.main}>
      <div className={page.topRow}>
        <Link
          viewTransition
          className={`sk press ${page.back}`}
          to={back}
          aria-label={back === '/' ? t.backAria : t.back}
        >
          <Ink />
          <Icon name="back" size={22} strokeWidth={2.4} />
          <span className={page.backLabel} aria-hidden="true">
            {t.back}
          </span>
        </Link>
        <span className={page.statusTilt}>
          <span className={`sk flat ${page.status} ${page.statusWant}`}>
            <Ink />
            <Icon name="friends" size={15} strokeWidth={2.4} />
            {t.sharedPlace.badge}
          </span>
        </span>
      </div>

      <div className={page.layout}>
        <div className={page.colA}>
          <div className={page.photoWrap}>
            <MiniMap
              origin={origin}
              to={place.location}
              travel={travel}
              caption={t.sharedPlace.mapAria(
                t.minutes(travel.minutes),
                t.travelMode[travel.mode],
                fromLabel,
              )}
              title={t.sharedPlace.mapTitle}
            />
          </div>
          <dl className={page.stats}>
            <div className={`sk flat ${page.stat}`}>
              <Ink />
              <dt>{t.travelMode[travel.mode]}</dt>
              <dd>{t.minutes(travel.minutes)}</dd>
            </div>
            <div className={`sk flat ${page.stat}`}>
              <Ink />
              <dt>{from === 'here' ? t.stats.fromHere : t.stats.fromHome}</dt>
              <dd>{t.distance(travel.km, travel.miles)}</dd>
            </div>
            {knownKind && (
              <div className={`sk flat ${page.stat}`}>
                <Ink />
                <dt>{t.stats.kind}</dt>
                <dd>{t.kinds[knownKind]}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className={page.colB}>
          <div className={page.titleBlock}>
            <h1 className={page.title}>
              {nameA && `${nameA} `}
              <span className="hl">{nameB}</span>
            </h1>
            {place.address && <p className={page.address}>{place.address}</p>}
            <button
              type="button"
              className={`sk press ${styles.add}`}
              onClick={() => void add()}
              disabled={adding || !actions?.addSharedPlace}
              aria-busy={adding}
              aria-labelledby="add-shared-label"
            >
              <SpotLabel id="add-shared-label" parts={t.sharedPlace.addAria} spot={place} />
              <Ink />
              <Icon name="plus" size={22} strokeWidth={2.6} />
              {adding ? t.sharedPlace.adding : t.sharedPlace.add}
            </button>
            <div role="status">{error && <p className={`note ${styles.error}`}>{error}</p>}</div>
          </div>

          {friendsTakes.length > 0 ? (
            <FriendTakesBox takes={friendsTakes} photos={photos} first={first} />
          ) : (
            <p className={`note ${styles.noTakes}`}>{t.sharedPlace.noTakes}</p>
          )}

          <div className={page.bar}>
            <a
              className={`sk press ${page.take}`}
              href={appleMapsUrl(place.name, place.location, travel.mode)}
              target="_blank"
              rel="noopener noreferrer"
              aria-labelledby="take-label"
            >
              <SpotLabel id="take-label" parts={t.mapsLabel(travel.mode)} spot={place} />
              <Ink />
              <Icon name="go" size={22} />
              {t.takeMeThere}
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * A small hand-drawn map: where you measure from in the middle, the radar's
 * travel-time rings, and the place where its compass direction and travel
 * time put it. No tiles, no third-party script; the caption says it in words.
 */
function MiniMap({
  origin,
  to,
  travel,
  caption,
  title,
}: {
  origin: LatLng;
  to: LatLng;
  travel: TravelEstimate;
  caption: string;
  title: string;
}) {
  const bearing = bearingDeg(origin, to);
  // the radar's own geometry: diameter units (0..0.5 from the centre), here in a 200-wide box
  // never on top of the hub, however close
  const r = Math.max(30, radiusFor(travel.minutes, ringFor(travel.minutes)) * 200);
  const a = (bearing * Math.PI) / 180;
  const x = r * Math.sin(a);
  const y = -r * Math.cos(a);
  return (
    <figure className={`sk ${styles.map}`}>
      <Ink />
      <svg className={styles.mapSvg} viewBox="-100 -100 200 200" aria-hidden="true">
        {RING_DIAMETERS.map((d, i) => (
          <circle
            key={d}
            r={d * 100}
            fill="none"
            stroke="var(--rule)"
            strokeWidth={1.2}
            strokeDasharray={i === RING_DIAMETERS.length - 1 ? '3 4' : undefined}
          />
        ))}
        <path
          d={`M0 0 Q ${String(x * 0.5 + y * 0.12)} ${String(y * 0.5 - x * 0.12)} ${String(x)} ${String(y)}`}
          fill="none"
          stroke="var(--ink)"
          strokeWidth={1.6}
          strokeDasharray="4 4"
          strokeLinecap="round"
        />
        <circle r={6} fill="var(--card)" stroke="var(--ink)" strokeWidth={2} />
        <circle r={2} fill="var(--ink)" />
        <g transform={`translate(${String(x)} ${String(y)})`}>
          <circle r={8} fill="var(--tomato)" stroke="var(--ink)" strokeWidth={2.2} />
          <circle r={3} fill="var(--card)" />
        </g>
      </svg>
      <figcaption className={styles.mapCaption}>
        <span className={styles.mapTitle}>{title}</span> {caption}
      </figcaption>
    </figure>
  );
}
