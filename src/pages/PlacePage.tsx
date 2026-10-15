import { Ink } from '../components/Ink';
import { Link, useLocation, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { appleMapsUrl } from '../domain/maps';
import { parseHeadline } from '../domain/headlines';
import { dataLang } from '../domain/spot';
import { useT } from '../i18n/context';
import { Headline, SpotLabel, Unknown } from '../components/bits';
import { useOrigin } from '../lib/origin';
import { useSpots } from '../lib/spots';
import { useSpotViews } from '../lib/useSpotViews';
import { FriendTakes } from '../components/FriendTakes';
import { PhotoFrame } from '../components/PlacePhotos';
import { usePlacePhotos } from '../lib/usePlacePhotos';
import {
  NotesEditor,
  OrderEditor,
  SpotAdmin,
  StatusEditor,
  VisibilityEditor,
} from '../components/placeEditors';
import styles from './PlacePage.module.css';

/** Just added from the search (`state.added`): say so once, on arrival. */
function justAdded(state: unknown): boolean {
  return Boolean(state && typeof state === 'object' && 'added' in state && state.added === true);
}

function backTarget(state: unknown): string {
  if (state && typeof state === 'object' && 'back' in state && typeof state.back === 'string') {
    return state.back;
  }
  return '/';
}

/** Highlight the last word (or last two, for long names): "Lucky Thread [Noodle Bar]". */
function splitName(name: string): [string, string] {
  const words = name.split(' ');
  const n = words.length >= 3 ? 2 : 1;
  return [words.slice(0, -n).join(' '), words.slice(-n).join(' ')];
}

export function PlacePage() {
  const { id } = useParams();
  const location = useLocation();
  const { from } = useOrigin();
  const t = useT();
  const views = useSpotViews();
  const view = views.find((v) => v.spot.id === id);
  const back = backTarget(location.state);
  const canWrite = useSpots().actions !== null;
  const photos = usePlacePhotos(view?.spot.id, canWrite);

  if (!view) {
    return (
      <main id="main" className={`${styles.main} ${styles.notFound}`}>
        <Headline className={styles.title} parts={parseHeadline(t.spotNotFound)} />
        <p className="note" style={{ fontSize: 24 }}>
          {t.spotNotFoundBody}
        </p>
        <Link viewTransition to="/">
          {t.backToList}
        </Link>
      </main>
    );
  }

  const { spot, travel, ring } = view;
  const [nameA, nameB] = splitName(spot.name);
  const nearness = ring === 0 ? t.nearness[from] : ring === 3 ? t.roadTrip : null;
  // spot text is data in its own language; translated labels use the UI's
  const lang = dataLang(spot);
  // cuisine and price we don't know read as a hand-drawn "cuisine?" / "price?", never a guess
  const tags: { text: string; lang?: string; unknown?: 'cuisine' | 'price' }[] = [
    spot.cuisine ? { text: spot.cuisine, lang } : { text: t.unknown.cuisine, unknown: 'cuisine' },
    spot.price ? { text: spot.price } : { text: t.unknown.price, unknown: 'price' },
    ...spot.tags
      .filter((tag) => tag !== spot.cuisine)
      .map((tag) => (t.tags[tag] ? { text: t.tags[tag] } : { text: tag, lang })),
  ];
  if (nearness) tags.push({ text: nearness });

  return (
    <main id="main" className={styles.main}>
      <div className={styles.topRow}>
        <Link
          viewTransition
          className={`sk press ${styles.back}`}
          to={back}
          aria-label={t.backAria}
        >
          <Ink />
          <Icon name="back" size={22} strokeWidth={2.4} />
          <span className={styles.backLabel} aria-hidden="true">
            {t.back}
          </span>
        </Link>
        <span className={styles.statusTilt}>
          {spot.status === 'been' ? (
            <span className={`sk flat ${styles.status}`}>
              <Ink />
              <Icon name="check" size={15} strokeWidth={3} />
              {t.beenHere}
              {spot.verdict && (
                <span className={styles.verdict}> · {t.verdicts[spot.verdict]}</span>
              )}
            </span>
          ) : (
            <span className={`sk flat ${styles.status} ${styles.statusWant}`}>
              <Ink />
              <Icon name="star" size={15} strokeWidth={2.4} />
              {t.wantToTry}
            </span>
          )}
        </span>
      </div>

      <div className={styles.layout}>
        <div className={styles.colA}>
          <div className={styles.photoWrap}>
            <PhotoFrame spot={spot} photos={photos} canAdd={canWrite} />
          </div>

          <dl className={styles.stats}>
            <div className={`sk flat ${styles.stat}`}>
              <Ink />
              <dt>{t.travelMode[travel.mode]}</dt>
              <dd>{t.minutes(travel.minutes)}</dd>
            </div>
            <div className={`sk flat ${styles.stat}`}>
              <Ink />
              <dt>{from === 'here' ? t.stats.fromHere : t.stats.fromHome}</dt>
              <dd>{t.distance(travel.km, travel.miles)}</dd>
            </div>
            <div className={`sk flat ${styles.stat}`}>
              <Ink />
              <dt>{spot.hours ? t.stats.openTill : t.stats.kind}</dt>
              <dd>{spot.hours ? t.hours(spot.hours) : t.kinds[spot.kind]}</dd>
            </div>
          </dl>
        </div>

        <div className={styles.colB}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title} lang={lang}>
              {nameA && `${nameA} `}
              <span className="hl">{nameB}</span>
            </h1>
            {spot.address && <p className={styles.address}>{spot.address}</p>}
            {justAdded(location.state) && (
              <p role="status" className={`note ${styles.added}`}>
                {t.addSearch.added}
              </p>
            )}
            {spot.note && (
              <p className={`note ${styles.oneLiner}`} lang={lang}>
                {spot.note}
              </p>
            )}
            <ul className={styles.tags} aria-label={t.aboutSpot}>
              {tags.map((tag) => (
                <li key={tag.text} lang={tag.lang}>
                  {tag.unknown ? <Unknown what={tag.unknown} /> : tag.text}
                </li>
              ))}
            </ul>
          </div>

          {spot.why && (
            <section aria-labelledby="why" className={styles.why}>
              <div className={`sk ${styles.whyNote}`}>
                <Ink />
                <h2 id="why" className={styles.kicker}>
                  {t.whyTitle}
                </h2>
                <p className={styles.whyText} lang={lang}>
                  {spot.why.text}
                </p>
                <p className={styles.whyBy}>
                  {t.foundBy(t.formatDate(spot.why.foundOn), spot.foundBy)}
                </p>
              </div>
            </section>
          )}

          <StatusEditor spot={spot} />

          <FriendTakes placeId={spot.id} photos={photos.data?.friends} />

          <OrderEditor spot={spot} />

          <NotesEditor spot={spot} />

          <VisibilityEditor spot={spot} />

          <SpotAdmin spot={spot} />

          <div className={styles.bar}>
            <a
              className={`sk press ${styles.take}`}
              href={appleMapsUrl(spot.name, spot.location, travel.mode)}
              target="_blank"
              rel="noopener noreferrer"
              aria-labelledby="take-label"
            >
              <SpotLabel id="take-label" parts={t.mapsLabel(travel.mode)} spot={spot} />
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
