import { Ink } from '../components/Ink';
import { Link, useLocation, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { appleMapsUrl } from '../domain/maps';
import { parseHeadline } from '../domain/headlines';
import { dataLang } from '../domain/spot';
import { useT } from '../i18n/context';
import { Headline } from '../components/bits';
import { useOrigin } from '../lib/origin';
import { useSpotViews } from '../lib/useSpotViews';
import { FOOD_ICONS } from '../components/icons';
import styles from './PlacePage.module.css';

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

function CheckBox({ checked, variant }: { checked: boolean; variant: number }) {
  const boxes = [
    'M4 5.5c5-.8 11-1 17-.3.8 5 .6 10.5-.2 15.6-5.4.6-11 .5-16.3-.1C3.8 15.6 3.6 10.5 4 5.5z',
    'M4.3 5c5.3-.5 11-.6 16.8.2.6 5.2.5 10.6-.3 15.5-5.3.7-10.8.6-16.2 0-.7-5.3-.8-10.6-.3-15.7z',
    'M4 5.3c5.6-.6 11.3-.4 16.9.1.5 5.1.6 10.3-.1 15.4-5.5.6-11 .7-16.4.1C3.6 15.7 3.5 10.4 4 5.3z',
  ];
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      fill="none"
      stroke="var(--ink)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={boxes[variant % boxes.length]} />
      {checked && <path d="M8 13.5l3.6 4L22 4.5" stroke="var(--note-red)" strokeWidth="2.6" />}
    </svg>
  );
}

export function PlacePage() {
  const { id } = useParams();
  const location = useLocation();
  const { from } = useOrigin();
  const t = useT();
  const views = useSpotViews();
  const view = views.find((v) => v.spot.id === id);
  const back = backTarget(location.state);

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
  const tags: { text: string; lang?: string }[] = [
    { text: spot.cuisine, lang },
    { text: spot.price },
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
              {spot.rating !== undefined ? ` · ${spot.rating}/10` : ''}
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
            <div className={`sk ${styles.photo}`}>
              <Ink />
              <svg
                width="74"
                height="74"
                viewBox="0 0 24 24"
                fill="none"
                stroke="var(--ink)"
                strokeWidth="1.3"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={FOOD_ICONS[spot.icon]} />
              </svg>
              <span className={styles.photoCaption}>{t.noPhoto}</span>
            </div>
            <span aria-hidden="true" className={`${styles.tape} ${styles.tapeL}`} />
            <span aria-hidden="true" className={`${styles.tape} ${styles.tapeR}`} />
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
            <ul className={styles.tags} aria-label={t.aboutSpot}>
              {tags.map((tag) => (
                <li key={tag.text} lang={tag.lang}>
                  {tag.text}
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
                <p className={styles.whyBy}>{t.foundBy(t.formatDate(spot.why.foundOn))}</p>
              </div>
            </section>
          )}

          {spot.order.length > 0 && (
            <section aria-labelledby="order" className={styles.section}>
              <h2 id="order">{t.orderThis}</h2>
              <ul className={styles.orderList}>
                {spot.order.map((o, i) => (
                  <li key={o.dish}>
                    <CheckBox checked={o.tried} variant={i} />
                    <span>
                      <span lang={lang}>{o.dish}</span>
                      {o.tried ? (
                        <span className="visually-hidden">{t.hadIt}</span>
                      ) : (
                        <>
                          {' '}
                          <span className={styles.nextTime}>{t.nextTime}</span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="mine" className={styles.section}>
            <h2 id="mine">{t.myNote}</h2>
            <p
              className={styles.myNote}
              lang={spot.myNote || spot.status === 'been' ? lang : undefined}
            >
              {spot.myNote ?? (spot.status === 'been' ? spot.note : t.noNoteYet)}
            </p>
          </section>

          <div className={styles.bar}>
            <a
              className={`sk press ${styles.take}`}
              href={appleMapsUrl(spot.name, spot.location, travel.mode)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={t.mapsLabel(spot.name, travel.mode)}
            >
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
