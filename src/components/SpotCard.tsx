import { Ink } from './Ink';
import { Link, useLocation } from 'react-router';
import type { SpotView } from '../domain/spotView';
import { dataLang } from '../domain/spot';
import { useT } from '../i18n/context';
import { takesFor, useFriendTakes } from '../lib/friends';
import { CuisineOrKind, GoLink, PriceText, StatusBadge } from './bits';
import { FriendAvatars } from './FriendAvatars';
import { FoodTile } from './Icon';
import styles from './SpotCard.module.css';

export function SpotCard({
  view,
  index,
  onPoint,
}: {
  view: SpotView;
  index: number;
  /** Called with the spot id while the card is hovered or has focus, null after. */
  onPoint?: (id: string | null) => void;
}) {
  const { spot, travel } = view;
  const location = useLocation();
  const t = useT();
  // friends who've been here too (their friends-visible entries only; see the Worker)
  const friendsBeen = takesFor(useFriendTakes().takes, spot.id).been.map((take) => take.friend);
  // spot text is data in its own language, not the UI's
  const lang = dataLang(spot);
  return (
    <article
      className={`sk lift ${styles.card}`}
      aria-labelledby={`card-${spot.id}`}
      onMouseEnter={() => onPoint?.(spot.id)}
      onMouseLeave={() => onPoint?.(null)}
      onFocus={() => onPoint?.(spot.id)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) onPoint?.(null);
      }}
    >
      <Ink />
      <span className={styles.tile}>
        <FoodTile icon={spot.icon} index={index} />
      </span>
      <div className={styles.head}>
        <h3 className={styles.name} id={`card-${spot.id}`}>
          <Link
            viewTransition
            lang={lang}
            to={`/place/${spot.id}`}
            state={{ back: location.pathname + location.search }}
          >
            {spot.name}
          </Link>
        </h3>
        <div className={styles.meta}>
          <CuisineOrKind spot={spot} /> · <PriceText price={spot.price} />
        </div>
      </div>
      <div className={styles.time}>
        <span className={styles.minutes}>{t.minutes(travel.minutes)}</span>
        <span className={styles.how}>{t.travelMode[travel.mode]}</span>
      </div>
      {spot.note ? (
        <p className={`note ${styles.note}`} lang={lang}>
          {spot.note}
        </p>
      ) : (
        <span className={styles.note} aria-hidden="true" />
      )}
      <span className={styles.rule} aria-hidden="true" />
      <div className={styles.foot}>
        <span className={styles.badge}>
          <StatusBadge status={spot.status} verdict={spot.verdict} />
          <FriendAvatars people={friendsBeen} />
        </span>
        <GoLink spot={spot} travel={travel} className={styles.go} labelClassName={styles.goLabel} />
      </div>
    </article>
  );
}
