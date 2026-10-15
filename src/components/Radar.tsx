import { Ink } from './Ink';
import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Kind } from '../domain/spot';
import type { From } from '../lib/origin';
import {
  DOT_TARGET_PX,
  HUB_DIAMETER,
  layoutRadar,
  PHONE_RADAR_PX,
  RING_DIAMETERS,
} from '../lib/radar';

/** Non-interactive dots (desktop mini radar) only need to not overlap visually. */
const STATIC_DOT_PX = 16;
import { byTravelTime, type SpotView } from '../domain/spotView';
import { useT } from '../i18n/context';
import type { Ring } from '../domain/travel';
import { SpotLabel } from './bits';
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
  const t = useT();
  const uid = useId();
  const interactive = Boolean(onSelect);
  const ref = useRef<HTMLDivElement>(null);
  // spacing depends on the rendered size: 40px tap targets must not overlap
  const [size, setSize] = useState(interactive ? PHONE_RADAR_PX : 260);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry?.contentRect.width;
      if (w) setSize(Math.round(w));
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
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
        { size, target: interactive ? DOT_TARGET_PX : STATIC_DOT_PX },
      ),
    [sorted, size, interactive],
  );

  return (
    <div
      ref={ref}
      className={`${styles.radar} ${className}`}
      role={interactive ? 'group' : 'img'}
      aria-label={interactive ? t.radarGroup(from) : t.radarImg(from)}
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
        >
          <Ink />
        </span>
      ))}
      {interactive &&
        t.ringLabels.map((label, i) => (
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
        className={`sk flat ${styles.home}`}
        style={{ width: `clamp(32px, ${HUB_DIAMETER * 100}%, 52px)` }}
        role="img"
        aria-label={t.hub[from]}
      >
        <Ink />
        <Icon name={from === 'home' ? 'home' : 'pin'} size={22} />
      </span>
      {sorted.map((v, i) => {
        const p = points[i];
        if (!p) return null;
        const pos = {
          left: `${p.x * 100}%`,
          top: `${p.y * 100}%`,
          '--i': i,
          '--dx': `${(0.5 - p.x) * 100}cqw`,
          '--dy': `${(0.5 - p.y) * 100}cqw`,
        };
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
            aria-labelledby={`${uid}-${v.spot.id}`}
            aria-pressed={selected}
            onClick={() => {
              onSelect(v.spot.id);
            }}
          >
            <SpotLabel
              id={`${uid}-${v.spot.id}`}
              spot={v.spot}
              parts={t.dotLabel(
                t.kinds[v.spot.kind],
                t.minutes(v.travel.minutes),
                t.travelMode[v.travel.mode],
                inReach,
              )}
            />
            {selected && (
              <span aria-hidden="true" className={`sk flat ${styles.selRing}`}>
                <Ink />
              </span>
            )}
            <KindMark kind={v.spot.kind} />
          </button>
        );
      })}
    </div>
  );
}
