import { Ink } from './Ink';
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { Spot } from '../domain/spot';
import { appleMapsUrl } from '../domain/maps';
import { useT } from '../i18n/context';
import type { TravelEstimate } from '../domain/travel';
import styles from './bits.module.css';
import { Icon } from './Icon';

export function Logo() {
  const t = useT();
  return (
    <Link viewTransition to="/" className={styles.logo} aria-label={t.logoLabel}>
      <span className={`sk flat boil ${styles.logoBlob}`} aria-hidden="true">
        <Ink boil />
        <Icon name="radar" size={24} strokeWidth={2} />
      </span>
      <span className={styles.logoText} aria-hidden="true">
        grub radar
      </span>
    </Link>
  );
}

export function StatusBadge({ status }: { status: Spot['status'] }) {
  const t = useT();
  return status === 'been' ? (
    <span className={`${styles.badge} ${styles.been}`}>
      <Icon name="check" size={13} strokeWidth={3} />
      {t.been}
    </span>
  ) : (
    <span className={`${styles.badge} ${styles.want}`}>
      <Icon name="star" size={13} strokeWidth={2.4} />
      {t.wantToTry}
    </span>
  );
}

/** Opens Apple Maps directions. Round on phones; `labelClassName` can reveal the text. */
export function GoLink({
  spot,
  travel,
  className = '',
  label,
  labelClassName,
}: {
  spot: Spot;
  travel: TravelEstimate;
  className?: string;
  label?: string;
  labelClassName?: string;
}) {
  const t = useT();
  return (
    <a
      className={`sk press ${styles.go} ${className}`}
      href={appleMapsUrl(spot.name, spot.location, travel.mode)}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t.mapsLabel(spot.name, travel.mode)}
    >
      <Ink />
      <Icon name="go" size={20} />
      <span className={labelClassName ?? 'visually-hidden'}>{label ?? t.appleMaps}</span>
    </a>
  );
}

/** "what are we [eating] tonight?" (spacing lives in the parts) */
export function Headline({
  parts,
  className,
  id,
  draw = false,
  style,
}: {
  parts: readonly [string, string, string];
  className?: string;
  style?: CSSProperties;
  id?: string;
  /** Animate the highlighter in. */
  draw?: boolean;
}) {
  const [pre, hl, post] = parts;
  return (
    <h1 className={className} id={id} style={style}>
      {pre}
      <span className={draw ? 'hl hl-draw' : 'hl'}>{hl}</span>
      {post}
    </h1>
  );
}
