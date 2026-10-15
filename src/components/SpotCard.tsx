import { Ink } from './Ink';
import { Link, useLocation } from 'react-router';
import type { SpotView } from '../domain/spotView';
import { useT } from '../i18n/context';
import { GoLink, StatusBadge } from './bits';
import { FoodTile } from './Icon';
import styles from './SpotCard.module.css';

export function SpotCard({ view, index }: { view: SpotView; index: number }) {
  const { spot, travel } = view;
  const location = useLocation();
  const t = useT();
  return (
    <article className={`sk lift ${styles.card}`} aria-labelledby={`card-${spot.id}`}>
      <Ink />
      <span className={styles.tile}>
        <FoodTile icon={spot.icon} index={index} />
      </span>
      <div className={styles.head}>
        <h3 className={styles.name} id={`card-${spot.id}`}>
          <Link
            viewTransition
            to={`/place/${spot.id}`}
            state={{ back: location.pathname + location.search }}
          >
            {spot.name}
          </Link>
        </h3>
        <div className={styles.meta}>
          {spot.cuisine} · {spot.price}
        </div>
      </div>
      <div className={styles.time}>
        <span className={styles.minutes}>{t.minutes(travel.minutes)}</span>
        <span className={styles.how}>{t.travelMode[travel.mode]}</span>
      </div>
      <p className={`note ${styles.note}`}>{spot.note}</p>
      <span className={styles.rule} aria-hidden="true" />
      <div className={styles.foot}>
        <span className={styles.badge}>
          <StatusBadge status={spot.status} />
        </span>
        <GoLink spot={spot} travel={travel} className={styles.go} labelClassName={styles.goLabel} />
      </div>
    </article>
  );
}
