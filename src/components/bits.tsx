import { Link } from 'react-router';
import type { Spot } from '../domain/spot';
import { appleMapsUrl, mapsLabel } from '../domain/maps';
import type { TravelEstimate } from '../domain/travel';
import styles from './bits.module.css';
import { Icon } from './Icon';

export function Logo() {
  return (
    <Link to="/" className={styles.logo} aria-label="grub radar, home">
      <span className={`sk flat boil ${styles.logoBlob}`} aria-hidden="true">
        <Icon name="radar" size={24} strokeWidth={2} />
      </span>
      <span className={styles.logoText} aria-hidden="true">
        grub radar
      </span>
    </Link>
  );
}

export function StatusBadge({ status }: { status: Spot['status'] }) {
  return status === 'been' ? (
    <span className={`${styles.badge} ${styles.been}`}>
      <Icon name="check" size={13} strokeWidth={3} />
      been
    </span>
  ) : (
    <span className={`${styles.badge} ${styles.want}`}>
      <Icon name="star" size={13} strokeWidth={2.4} />
      want to try
    </span>
  );
}

/** Opens Apple Maps directions. Round on phones; `labelClassName` can reveal the text. */
export function GoLink({
  spot,
  travel,
  className = '',
  label = 'Apple Maps',
  labelClassName,
}: {
  spot: Spot;
  travel: TravelEstimate;
  className?: string;
  label?: string;
  labelClassName?: string;
}) {
  return (
    <a
      className={`sk press ${styles.go} ${className}`}
      href={appleMapsUrl(spot.name, spot.location, travel.mode)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={mapsLabel(spot, travel)}
    >
      <Icon name="go" size={20} />
      <span className={labelClassName ?? 'visually-hidden'}>{label}</span>
    </a>
  );
}

/** "what are we [eating] tonight?" */
export function Headline({
  parts,
  className,
  id,
}: {
  parts: readonly [string, string, string];
  className?: string;
  id?: string;
}) {
  const [pre, hl, post] = parts;
  return (
    <h1 className={className} id={id}>
      {pre} <span className="hl">{hl}</span>
      {post}
    </h1>
  );
}
