import { useEffect, useMemo, useState, type SyntheticEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Headline } from '../components/bits';
import { FromToggle } from '../components/controls';
import { InkBox } from '../components/fields';
import { inputClass } from '../components/fieldClasses';
import { FoodTile, Icon } from '../components/Icon';
import { Ink } from '../components/Ink';
import type { ApplePlace } from '../contracts/places';
import type { Origin } from '../contracts/spots';
import { defaultIcon, guessLang } from '../domain/edits';
import { parseHeadline } from '../domain/headlines';
import type { LatLng } from '../domain/geo';
import type { Spot } from '../domain/spot';
import { estimateTravel } from '../domain/travel';
import { useI18n } from '../i18n/context';
import { useAuth } from '../lib/auth';
import { saveErrorMessage } from '../lib/errors';
import { TYPED_NAV_STATE, useExternalNavKey, useImeSafeInput } from '../lib/ime';
import { useOrigin } from '../lib/origin';
import { SEARCH_DEBOUNCE_MS, usePlaceSearch, type PlaceSearchState } from '../lib/placeSearch';
import { useSpots } from '../lib/spots';
import styles from './AddSearchPage.module.css';

/**
 * Where to search: your saved home by reference ("home": the server knows
 * it, so it never travels in a URL), else the point distances are measured
 * from (where you are, the demo home, or a home kept on this device only),
 * which placeSearch rounds to ~1 km.
 */
function useSearchCentre(): { near: Origin; origin: LatLng } {
  const { from, origin, homeIsDemo } = useOrigin();
  const { state } = useAuth();
  const accountHome = state.status === 'signed-in' && state.me.home !== null;
  return { near: from === 'home' && !homeIsDemo && accountHome ? 'home' : origin, origin };
}

/**
 * `/add`: find a place on Apple Maps and put it on your radar in one tap.
 * Apple's places show up only here; the list and radar show your own.
 */
export function AddSearchPage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const urlQ = params.get('q') ?? '';
  // While the page is mounted, what's typed is the truth. The URL is read on
  // mount, and again only after a navigation we didn't make (back/forward, the
  // header's bare /add): our own debounced ?q= writes, however late, never
  // come back into the box. `query` is the settled text (never pinyin still
  // being composed): it drives the search, and the URL mirrors it after a pause.
  const resetKey = useExternalNavKey();
  const [query, setQuery] = useState(urlQ);
  const [seenKey, setSeenKey] = useState(resetKey);
  if (resetKey !== seenKey) {
    setSeenKey(resetKey);
    setQuery(urlQ);
  }
  const [failed, setFailed] = useState<string | null>(null);
  const box = useImeSafeInput({
    value: urlQ,
    resetKey,
    onCommit: (q) => {
      setQuery(q);
      setFailed(null);
    },
  });
  const { from } = useOrigin();
  const { near, origin } = useSearchCentre();
  const { spots, actions } = useSpots();
  const { state, now } = usePlaceSearch(query, near, locale, origin);
  // while a newer search loads, the old results are only a placeholder: no taps
  const stale = state.status === 'loading';
  const [adding, setAdding] = useState<string | null>(null);

  // places already on your list, by Apple id: tapping one opens your entry
  const mine = useMemo(() => {
    const m = new Map<string, Spot>();
    for (const s of spots) if (s.applePlaceId) m.set(s.applePlaceId, s);
    return m;
  }, [spots]);

  // in the URL, so "back" from a place returns to the same search. Not on
  // every keystroke: a navigation mid-composition makes Safari commit the
  // pinyin typed so far ("bbabaobao zbao zi")
  const writeUrl = (q: string) => {
    if (q !== urlQ) setParams(q ? { q } : {}, { replace: true, state: TYPED_NAV_STATE });
  };
  useEffect(() => {
    if (box.composing || query === urlQ) return;
    const timer = setTimeout(() => {
      setParams(query ? { q: query } : {}, { replace: true, state: TYPED_NAV_STATE });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [box.composing, query, urlQ, setParams]);

  const add = async (place: ApplePlace) => {
    if (!actions?.addApplePlace || adding || stale) return;
    setAdding(place.applePlaceId);
    setFailed(null);
    try {
      const spot = await actions.addApplePlace({
        applePlaceId: place.applePlaceId,
        ...(place.kind ? { kind: place.kind } : {}),
      });
      void navigate(`/place/${spot.id}`, {
        viewTransition: true,
        state: { back: '/', added: true },
      });
    } catch (e) {
      setAdding(null);
      setFailed(saveErrorMessage(e, t));
    }
  };

  const submit = (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    writeUrl(query);
    now();
  };

  const places = state.status === 'ready' || state.status === 'loading' ? state.places : [];
  const manualTo = query.trim()
    ? `/add/manual?name=${encodeURIComponent(query.trim())}`
    : '/add/manual';

  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.addTitle)} />

      <form role="search" className={styles.searchRow} onSubmit={submit}>
        <InkBox>
          <span className={styles.searchIcon} aria-hidden="true">
            <Icon name="search" size={20} />
          </span>
          <input
            className={`${inputClass} ${styles.input}`}
            type="search"
            aria-label={t.addSearch.label}
            placeholder={t.addSearch.placeholder}
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            // the one thing to do on this page
            autoFocus
            maxLength={100}
            {...box.inputProps}
          />
        </InkBox>
      </form>
      <div className={styles.around}>
        <span>{t.addSearch.near[from]}</span>
        <span className="phone-only">
          <FromToggle compact />
        </span>
      </div>

      <p role="status" className={styles.status}>
        {statusLine(state, box.draft, t)}
      </p>
      {failed && (
        <p role="alert" className={styles.failed}>
          {failed}
        </p>
      )}

      {places.length > 0 && (
        <ul
          className={`${styles.results} ${state.status === 'loading' ? styles.stale : ''}`}
          aria-label={t.addSearch.resultsLabel}
          aria-busy={state.status === 'loading'}
        >
          {places.map((place, i) => (
            <Result
              key={place.applePlaceId}
              place={place}
              index={i}
              origin={origin}
              spot={mine.get(place.applePlaceId)}
              adding={adding === place.applePlaceId}
              stale={stale}
              disabled={stale || adding !== null || !actions?.addApplePlace}
              onAdd={() => void add(place)}
            />
          ))}
        </ul>
      )}

      <div className={styles.foot}>
        {places.length > 0 && <p className={styles.credit}>{t.addSearch.credit}</p>}
        <Link viewTransition to={manualTo} className={styles.manual}>
          {t.addSearch.manual}
          <Icon name="go" size={16} strokeWidth={2.4} />
        </Link>
      </div>
    </main>
  );
}

function statusLine(
  state: PlaceSearchState,
  text: string,
  t: ReturnType<typeof useI18n>['t'],
): string {
  switch (state.status) {
    case 'idle':
      return text.trim() ? '' : t.addSearch.hint;
    case 'loading':
      return t.addSearch.searching;
    case 'ready':
      return state.places.length
        ? t.addSearch.found(state.places.length)
        : t.addSearch.none(state.q);
    case 'error':
      return state.code === 'rate_limited' ? t.addSearch.tooFast : t.addSearch.failed;
  }
}

function Result({
  place,
  index,
  origin,
  spot,
  adding,
  stale,
  disabled,
  onAdd,
}: {
  place: ApplePlace;
  index: number;
  origin: LatLng;
  spot: Spot | undefined;
  adding: boolean;
  /** An older answer, shown while a newer search loads: nothing here acts. */
  stale: boolean;
  disabled: boolean;
  onAdd: () => void;
}) {
  const { t } = useI18n();
  const travel = estimateTravel(origin, place.location);
  const lang = guessLang(place.name) ?? 'en';
  const kind = place.kind ?? 'food';
  const [before, after] = spot ? t.addSearch.onListAria : t.addSearch.addAria;
  const label = `${before}${place.name}${after}`;
  return (
    <li className={`sk flat ${styles.result} ${spot ? styles.onList : ''}`}>
      <Ink />
      <span className={styles.tile}>
        <FoodTile icon={spot?.icon ?? defaultIcon(kind)} index={index} size={46} />
      </span>
      <span className={styles.what}>
        <span className={styles.name} lang={lang}>
          {place.name}
        </span>
        <span className={styles.meta}>
          {t.kinds[kind]}
          {place.address ? ` · ${place.address}` : ''}
        </span>
      </span>
      <span className={styles.far}>
        <span className={styles.distance}>{t.distance(travel.km, travel.miles)}</span>
        <span className={styles.how}>
          {t.minutes(travel.minutes)} {t.travelMode[travel.mode]}
        </span>
      </span>
      {spot && stale ? (
        <span className={`sk flat ${styles.action} ${styles.mine}`} aria-disabled="true">
          <Ink />
          <Icon name="check" size={16} strokeWidth={3} />
          <span>{t.addSearch.onList}</span>
        </span>
      ) : spot ? (
        <Link
          viewTransition
          to={`/place/${spot.id}`}
          state={{ back: '/' }}
          className={`sk flat ${styles.action} ${styles.mine}`}
          aria-label={label}
        >
          <Ink />
          <Icon name="check" size={16} strokeWidth={3} />
          <span>{t.addSearch.onList}</span>
        </Link>
      ) : (
        <button
          type="button"
          className={`sk press ${styles.action}`}
          aria-label={label}
          aria-busy={adding}
          aria-disabled={disabled}
          disabled={disabled}
          onClick={onAdd}
        >
          <Ink />
          <Icon name="plus" size={16} strokeWidth={2.8} />
          <span>{adding ? t.addSearch.adding : t.addSearch.add}</span>
        </button>
      )}
    </li>
  );
}
