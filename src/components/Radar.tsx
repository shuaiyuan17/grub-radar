import { useMemo } from 'react';
import type { Kind } from '../domain/spot';
import type { From } from '../lib/origin';
import { HUB_DIAMETER, layoutRadar, RING_DIAMETERS } from '../lib/radar';
import { byTravelTime, describeDot, type SpotView } from '../domain/spotView';
import { RING_LABELS, type Ring } from '../domain/travel';
import { Icon } from './Icon';
import styles from './Radar.module.css';

export function KindMark({
  kind,
  size = 'normal',
}: {
  kind: Kind;
  size?: 'normal' | 'small' | 'tiny';
}) {
  const sizeClass = size === 'small' ? styles.small : size === 'tiny' ? styles.tiny : '';
  return <span aria-hidden="true" className={`${styles.mark} ${styles[kind]} ${sizeClass}`} />;
}

const RING_CLASS = [styles.ring0, styles.ring1, styles.ring2, styles.ring3] as const;
// label backgrounds sit on whatever is under the top of that ring
const LABEL_BG = ['var(--card)', 'var(--card)', 'var(--paper)', 'var(--paper)'] as const;

interface RadarProps {
  views: readonly SpotView[];
  from: From;
  /** Dots beyond this ring are faded. */
  reach?: Ring;
  selectedId?: string | null;
  /** Makes dots tappable. Without it the radar is a picture (role="img"). */
  onSelect?: (id: string) => void;
  className?: string;
}

export function Radar({
  views,
  from,
  reach = 3,
  selectedId = null,
  onSelect,
  className = '',
}: RadarProps) {
  const sorted = useMemo(() => [...views].sort(byTravelTime), [views]);
  const points = useMemo(
    () =>
      layoutRadar(
        sorted.map((v) => ({
          id: v.spot.id,
          minutes: v.travel.minutes,
          ring: v.ring,
          bearing: v.bearing,
        })),
      ),
    [sorted],
  );
  const where = from === 'home' ? 'home' : 'you';
  const interactive = Boolean(onSelect);

  return (
    <div
      className={`${styles.radar} ${className}`}
      role={interactive ? 'group' : 'img'}
      aria-label={
        interactive
          ? `Places around ${where} by travel time`
          : `Radar of saved places around ${where}, in 10 minute, 30 minute, 1 hour and road trip rings`
      }
    >
      {[3, 2, 1, 0].map((i) => (
        <span
          key={`ring${i}`}
          aria-hidden="true"
          className={`sk flat ${styles.ring} ${RING_CLASS[i] ?? ''}`}
          style={{
            width: `${(RING_DIAMETERS[i] ?? 1) * 100}%`,
            height: `${(RING_DIAMETERS[i] ?? 1) * 100}%`,
            opacity: i === 0 || i <= reach ? 1 : 0.3,
          }}
        />
      ))}
      {interactive &&
        RING_LABELS.map((label, i) => (
          <span
            key={label}
            aria-hidden="true"
            className={styles.label}
            style={{
              top: `${50 - ((RING_DIAMETERS[i] ?? 1) / 2) * 100}%`,
              background: LABEL_BG[i],
              opacity: i <= Math.max(reach, 0) || i === 0 ? 1 : 0.3,
            }}
          >
            {label}
          </span>
        ))}
      <span
        className={`sk flat boil ${styles.home}`}
        style={{ width: `clamp(32px, ${HUB_DIAMETER * 100}%, 52px)` }}
        role="img"
        aria-label={from === 'home' ? 'Home' : 'You are here'}
      >
        <Icon name={from === 'home' ? 'home' : 'pin'} size={22} />
      </span>
      {sorted.map((v, i) => {
        const p = points[i];
        if (!p) return null;
        const pos = { left: `${p.x * 100}%`, top: `${p.y * 100}%` };
        const inReach = v.ring <= reach;
        if (!onSelect) {
          return (
            <span key={v.spot.id} className={styles.staticDot} style={pos}>
              <KindMark kind={v.spot.kind} size="small" />
            </span>
          );
        }
        const selected = v.spot.id === selectedId;
        return (
          <button
            key={v.spot.id}
            type="button"
            className={`${styles.dot} ${inReach ? '' : styles.out}`}
            style={pos}
            aria-label={describeDot(v, inReach)}
            aria-pressed={selected}
            onClick={() => {
              onSelect(v.spot.id);
            }}
          >
            {selected && <span aria-hidden="true" className={`sk flat boil ${styles.selRing}`} />}
            <KindMark kind={v.spot.kind} />
          </button>
        );
      })}
    </div>
  );
}
