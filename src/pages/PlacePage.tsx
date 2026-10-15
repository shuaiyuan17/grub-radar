import { Link, useLocation, useParams } from 'react-router';
import { Icon } from '../components/Icon';
import { appleMapsUrl, mapsLabel } from '../domain/maps';
import { useOrigin } from '../lib/origin';
import { formatMiles, formatMinutes } from '../domain/travel';
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

const dateFmt = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  timeZone: 'UTC',
});

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
  const views = useSpotViews();
  const view = views.find((v) => v.spot.id === id);
  const back = backTarget(location.state);

  if (!view) {
    return (
      <main id="main" className={`${styles.main} ${styles.notFound}`}>
        <h1 className={styles.title}>
          that spot&apos;s <span className="hl">not here</span>.
        </h1>
        <p className="note" style={{ fontSize: 24 }}>
          maybe it got renamed. maybe it closed. either way:
        </p>
        <Link to="/">back to the list</Link>
      </main>
    );
  }

  const { spot, travel, ring } = view;
  const [nameA, nameB] = splitName(spot.name);
  const where = from === 'home' ? 'home' : 'you';
  const nearness = ring === 0 ? `near ${where}` : ring === 3 ? 'road trip' : null;
  const tags = [spot.cuisine, spot.price, ...spot.tags.filter((t) => t !== spot.cuisine)];
  if (nearness) tags.push(nearness);

  return (
    <main id="main" className={styles.main}>
      <div className={styles.topRow}>
        <Link className={`sk press ${styles.back}`} to={back} aria-label="Back to the list">
          <Icon name="back" size={22} strokeWidth={2.4} />
          <span className={styles.backLabel} aria-hidden="true">
            back
          </span>
        </Link>
        <span className={styles.statusTilt}>
          {spot.status === 'been' ? (
            <span className={`sk flat ${styles.status}`}>
              <Icon name="check" size={15} strokeWidth={3} />
              been here{spot.rating !== undefined ? ` · ${spot.rating}/10` : ''}
            </span>
          ) : (
            <span className={`sk flat ${styles.status} ${styles.statusWant}`}>
              <Icon name="star" size={15} strokeWidth={2.4} />
              want to try
            </span>
          )}
        </span>
      </div>

      <div className={styles.layout}>
        <div className={styles.colA}>
          <div className={styles.photoWrap}>
            <div className={`sk ${styles.photo}`}>
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
              <span className={styles.photoCaption}>no photo yet</span>
            </div>
            <span aria-hidden="true" className={`${styles.tape} ${styles.tapeL}`} />
            <span aria-hidden="true" className={`${styles.tape} ${styles.tapeR}`} />
          </div>

          <dl className={styles.stats}>
            <div className={`sk flat ${styles.stat}`}>
              <dt>{travel.mode}</dt>
              <dd>{formatMinutes(travel.minutes)}</dd>
            </div>
            <div className={`sk flat ${styles.stat}`}>
              <dt>from {where === 'you' ? 'here' : 'home'}</dt>
              <dd>{formatMiles(travel.miles)}</dd>
            </div>
            <div className={`sk flat ${styles.stat}`}>
              <dt>{spot.openTill ? 'open till' : 'kind'}</dt>
              <dd>{spot.openTill ?? spot.kind}</dd>
            </div>
          </dl>
        </div>

        <div className={styles.colB}>
          <div className={styles.titleBlock}>
            <h1 className={styles.title}>
              {nameA && `${nameA} `}
              <span className="hl">{nameB}</span>
            </h1>
            <ul className={styles.tags} aria-label="About this spot">
              {tags.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>

          {spot.why && (
            <section aria-labelledby="why" className={styles.why}>
              <div className={`sk ${styles.whyNote}`}>
                <h2 id="why" className={styles.kicker}>
                  why it&apos;s on the list
                </h2>
                <p className={styles.whyText}>{spot.why.text}</p>
                <p className={styles.whyBy}>
                  found by your agent · {dateFmt.format(new Date(spot.why.foundOn)).toLowerCase()}
                </p>
              </div>
            </section>
          )}

          {spot.order.length > 0 && (
            <section aria-labelledby="order" className={styles.section}>
              <h2 id="order">order this</h2>
              <ul className={styles.orderList}>
                {spot.order.map((o, i) => (
                  <li key={o.dish}>
                    <CheckBox checked={o.tried} variant={i} />
                    <span>
                      {o.dish}
                      {o.tried ? (
                        <span className="visually-hidden"> (had it)</span>
                      ) : (
                        <>
                          {' '}
                          <span className={styles.nextTime}>next time</span>
                        </>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="mine" className={styles.section}>
            <h2 id="mine">my note</h2>
            <p className={styles.myNote}>
              {spot.myNote ??
                (spot.status === 'been' ? spot.note : 'nothing yet. go, then scribble.')}
            </p>
          </section>

          <div className={styles.bar}>
            <a
              className={`sk press ${styles.take}`}
              href={appleMapsUrl(spot.name, spot.location, travel.mode)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={mapsLabel(spot, travel)}
            >
              <Icon name="go" size={22} />
              take me there
            </a>
          </div>
        </div>
      </div>
    </main>
  );
}
