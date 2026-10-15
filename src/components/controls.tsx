import { Link, NavLink, useLocation } from 'react-router';
import { MODE_DEFS, MODES, type Mode } from '../domain/modes';
import { useOrigin } from '../lib/origin';
import type { SpotView } from '../domain/spotView';
import { formatMinutes } from '../domain/travel';
import { GoLink } from './bits';
import styles from './controls.module.css';
import { Icon } from './Icon';
import type { UI_ICONS } from './icons';

export function FromToggle({ compact = false }: { compact?: boolean }) {
  const { from, status, chooseHome, chooseHere } = useOrigin();
  const locating = status === 'locating';
  const opts = [
    { key: 'home', label: 'home', on: from === 'home' && !locating, pick: chooseHome },
    {
      key: 'here',
      label: locating ? 'finding you…' : 'where i am',
      on: from === 'here' || locating,
      pick: chooseHere,
    },
  ] as const;
  return (
    <div className={styles.from} role="group" aria-label="Measure distances from">
      {!compact && <Icon name="pin" size={16} />}
      <span aria-hidden="true">{compact ? 'from' : 'distances from'}</span>
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.on}
          aria-busy={o.key === 'here' && locating}
          className={o.on ? `sk flat ${styles.fromOn}` : styles.fromOff}
          onClick={o.pick}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

const MODE_ICONS: Record<Mode, keyof typeof UI_ICONS> = {
  near: 'pin',
  weekend: 'sun',
  coffee: 'cup',
};

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  return (
    <div className={`sk flat ${styles.modes}`} role="group" aria-label="What kind of idea">
      {MODES.map((m) => {
        const on = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            className={`${on ? 'sk flat ' : ''}${styles.mode}`}
            onClick={() => {
              onChange(m);
            }}
          >
            <Icon name={MODE_ICONS[m]} size={18} strokeWidth={on ? 2.2 : 2} />
            {MODE_DEFS[m].label}
          </button>
        );
      })}
    </div>
  );
}

export function ChipRow({
  chips,
  value,
  onChange,
}: {
  chips: readonly string[];
  value: string;
  onChange: (tag: string) => void;
}) {
  if (chips.length <= 1) return null;
  return (
    <div className={`noscroll ${styles.chips}`} role="group" aria-label="Craving">
      {chips.map((c) => (
        <button
          key={c}
          type="button"
          aria-pressed={c === value}
          className={`sk press ${styles.chip}`}
          onClick={() => {
            onChange(c);
          }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  id,
  autoFocus = false,
  className = '',
}: {
  value: string;
  onChange: (q: string) => void;
  id: string;
  autoFocus?: boolean;
  className?: string;
}) {
  return (
    <label className={`sk flat ${styles.search} ${className}`} htmlFor={id}>
      <Icon name="search" size={20} />
      <span className="visually-hidden">Search my spots</span>
      <input
        id={id}
        className={styles.searchInput}
        type="search"
        placeholder="search my spots, dishes, notes…"
        autoComplete="off"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </label>
  );
}

export function DiceButton({
  onRoll,
  big = false,
  disabled = false,
}: {
  onRoll: () => void;
  big?: boolean;
  disabled?: boolean;
}) {
  if (big) {
    return (
      <button
        type="button"
        className={`sk press boil ${styles.diceBig}`}
        onClick={onRoll}
        disabled={disabled}
      >
        <Icon name="dice" size={44} strokeWidth={1.8} />
        <span>
          <span className={styles.diceBigTitle}>can&apos;t decide?</span>
          <span className={styles.diceBigSub}>roll the dice on what&apos;s in range</span>
        </span>
      </button>
    );
  }
  return (
    <span className={styles.diceTilt}>
      <button
        type="button"
        className={`sk press boil ${styles.diceSmall}`}
        onClick={onRoll}
        disabled={disabled}
      >
        <Icon name="dice" size={20} strokeWidth={2.1} />
        can&apos;t decide? roll
      </button>
    </span>
  );
}

/** "the dice says…" sticky. Lives in a polite live region so rolls are announced. */
export function RollResult({
  view,
  rolled,
  onClear,
}: {
  view: SpotView | null;
  rolled: boolean;
  onClear: () => void;
}) {
  const location = useLocation();
  return (
    <div aria-live="polite">
      {rolled && (
        <div className={`sk ${styles.roll}`}>
          <div className={styles.rollBody}>
            <div className={styles.rollKicker}>the dice says…</div>
            {view ? (
              <>
                <Link
                  className={styles.rollName}
                  to={`/place/${view.spot.id}`}
                  state={{ back: location.pathname + location.search }}
                >
                  {view.spot.name}
                </Link>
                <div className={styles.rollMeta}>
                  {formatMinutes(view.travel.minutes)} {view.travel.mode} · {view.spot.cuisine}
                </div>
              </>
            ) : (
              <div className={styles.rollEmpty}>nothing in range. widen the net.</div>
            )}
          </div>
          {view && <GoLink spot={view.spot} travel={view.travel} />}
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Clear the roll"
            onClick={onClear}
          >
            <Icon name="close" size={18} strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
}

export function BottomNav() {
  const location = useLocation();
  const items = [
    { to: '/', label: 'list', icon: 'list' as const, end: true },
    { to: '/radar', label: 'radar', icon: 'radar' as const, end: false },
  ];
  return (
    <nav aria-label="View" className={`phone-only ${styles.bottomNav}`}>
      <div className={`sk ${styles.bottomNavInner}`}>
        {items.map((it) => {
          const active = it.end ? location.pathname === '/' : location.pathname.startsWith(it.to);
          return (
            <NavLink
              key={it.to}
              to={it.to}
              end={it.end}
              className={`${active ? 'sk flat ' : ''}${styles.navItem}`}
            >
              <Icon name={it.icon} size={18} />
              {it.label}
            </NavLink>
          );
        })}
      </div>
    </nav>
  );
}

export function OriginNotice() {
  const { notice, dismissNotice } = useOrigin();
  return (
    <div role="status">
      {notice && (
        <div className={`sk ${styles.notice}`}>
          <p>{notice}</p>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Dismiss"
            onClick={dismissNotice}
          >
            <Icon name="close" size={18} strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
}
