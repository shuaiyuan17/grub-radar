import { Link, useLocation, useSearchParams } from 'react-router';
import { GoLink } from '../components/bits';
import { BottomNav, DiceButton } from '../components/controls';
import { FoodTile } from '../components/Icon';
import { KindMark, Radar } from '../components/Radar';
import { KINDS, type Kind } from '../domain/spot';
import { useOrigin } from '../lib/origin';
import { roll } from '../domain/roll';
import { findNearby } from '../domain/nearby';
import {
  formatMinutes,
  isRing,
  MAX_RING,
  RING_LABELS,
  maxMinutesForRing,
  type Ring,
} from '../domain/travel';
import { useSpots } from '../lib/spots';
import { useSpotViews } from '../lib/useSpotViews';
import styles from './RadarPage.module.css';

function parseReach(raw: string | null): Ring {
  const n = Number(raw);
  return raw !== null && isRing(n) ? n : MAX_RING;
}

function parseKinds(raw: string | null): Set<Kind> {
  if (raw === null) return new Set(KINDS);
  return new Set(KINDS.filter((k) => raw.split(',').includes(k)));
}

export function RadarPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const { from, origin } = useOrigin();
  const { spots } = useSpots();
  const views = useSpotViews();

  const reach = parseReach(params.get('reach'));
  const kinds = parseKinds(params.get('kinds'));
  const selId = params.get('sel');

  const shown = views.filter((v) => kinds.has(v.spot.kind));
  const inReach = findNearby(spots, {
    origin,
    maxMinutes: maxMinutesForRing(reach),
    kinds: [...kinds],
  });
  const selected = shown.find((v) => v.spot.id === selId) ?? null;
  const selectedIndex = selected ? views.indexOf(selected) : 0;

  const update = (patch: Record<string, string | null>) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (v === null) next.delete(k);
          else next.set(k, v);
        }
        return next;
      },
      { replace: true },
    );
  };

  const toggleKind = (k: Kind) => {
    const next = new Set(kinds);
    if (next.has(k)) next.delete(k);
    else next.add(k);
    update({
      kinds: next.size === KINDS.length ? null : KINDS.filter((x) => next.has(x)).join(','),
    });
  };

  const rollDice = () => {
    const pick = roll(
      inReach.map((v) => ({ id: v.spot.id })),
      selId,
    );
    if (pick) update({ sel: pick.id });
  };

  const where = from === 'home' ? 'home' : 'you';

  return (
    <main id="main" className={styles.main}>
      <div className={styles.layout}>
        <div className={styles.panel}>
          <Link to="/" className={`desktop-only ${styles.backLink}`}>
            ← back to the list
          </Link>
          <h1 className={styles.title}>
            how far will you <span className="hl">go</span>?
          </h1>
          <label className={styles.reachRow} htmlFor="reach">
            <span>up to</span>
            <input
              id="reach"
              className={styles.reach}
              type="range"
              min={0}
              max={MAX_RING}
              step={1}
              value={reach}
              aria-valuetext={RING_LABELS[reach]}
              onChange={(e) => {
                const n = Number(e.target.value);
                update({ reach: isRing(n) && n !== MAX_RING ? String(n) : null });
              }}
            />
            <span className={styles.reachValue} aria-hidden="true">
              {RING_LABELS[reach]}
            </span>
          </label>

          <div className={styles.legend} role="group" aria-label="Show kinds">
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={styles.kind}
                aria-pressed={kinds.has(k)}
                onClick={() => {
                  toggleKind(k);
                }}
              >
                <KindMark kind={k} size="tiny" />
                {k}
              </button>
            ))}
            <span className={styles.inReach} aria-live="polite">
              {inReach.length} in reach
            </span>
          </div>

          <div aria-live="polite" className={styles.cardSlot}>
            {selected ? (
              <article className={`sk ${styles.card}`} aria-label={selected.spot.name}>
                <FoodTile icon={selected.spot.icon} index={selectedIndex} />
                <div className={styles.cardBody}>
                  <Link
                    className={styles.cardName}
                    to={`/place/${selected.spot.id}`}
                    state={{ back: location.pathname + location.search }}
                  >
                    {selected.spot.name}
                  </Link>
                  <div className={styles.cardMeta}>
                    {selected.spot.cuisine} · {formatMinutes(selected.travel.minutes)}{' '}
                    {selected.travel.mode}
                  </div>
                  <div className={`note ${styles.cardNote}`}>{selected.spot.note}</div>
                </div>
                <GoLink spot={selected.spot} travel={selected.travel} />
              </article>
            ) : (
              <p className={styles.hint}>tap a dot to see the spot, or let the dice pick.</p>
            )}
          </div>

          <div className={styles.actions}>
            <DiceButton onRoll={rollDice} disabled={inReach.length === 0} />
          </div>
        </div>

        <div className={styles.radarWrap}>
          <Radar
            views={shown}
            from={from}
            reach={reach}
            selectedId={selected?.spot.id ?? null}
            onSelect={(id) => {
              update({ sel: id });
            }}
          />
          <p className="visually-hidden">
            {`Rings around ${where}: 10 minutes, 30 minutes, 1 hour, and road trip.`}
          </p>
        </div>
      </div>
      <BottomNav />
    </main>
  );
}
