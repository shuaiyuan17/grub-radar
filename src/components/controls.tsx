import { Ink } from './Ink';
import { useState } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { ALL, MODES, type Mode } from '../domain/modes';
import { dataLang } from '../domain/spot';
import { useI18n, useT } from '../i18n/context';
import { LOCALES, type Locale } from '../i18n/locales';
import { useOrigin } from '../lib/origin';
import type { SpotView } from '../domain/spotView';
import { GoLink } from './bits';
import styles from './controls.module.css';
import { Icon } from './Icon';
import type { UI_ICONS } from './icons';

export function FromToggle({ compact = false }: { compact?: boolean }) {
  const { from, status, chooseHome, chooseHere, openHomeEditor, homeIsDemo } = useOrigin();
  const t = useT();
  const locating = status === 'locating';
  const opts = [
    { key: 'home', label: t.home, on: from === 'home' && !locating, pick: chooseHome },
    {
      key: 'here',
      label: locating ? t.findingYou : t.whereIAm,
      on: from === 'here' || locating,
      pick: chooseHere,
    },
  ] as const;
  return (
    <div className={styles.from} role="group" aria-label={t.fromGroup}>
      {!compact && <Icon name="pin" size={16} />}
      <span aria-hidden="true">{compact ? t.fromShort : t.distancesFrom}</span>
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={o.on}
          aria-busy={o.key === 'here' && locating}
          className={`tap ${o.on ? `sk flat ${styles.fromOn}` : styles.fromOff}`}
          onClick={o.pick}
        >
          {o.on && <Ink />}
          {o.label}
        </button>
      ))}
      {homeIsDemo && !compact ? (
        <span className={styles.demoNote}>
          {t.demoHomeNote}{' '}
          <button type="button" className={`tap ${styles.setHome}`} onClick={openHomeEditor}>
            {t.setYourHome}
          </button>
        </span>
      ) : (
        <button
          type="button"
          className={`tap ${styles.setHome}`}
          onClick={openHomeEditor}
          aria-label={homeIsDemo ? t.setHomeAria : t.editHomeAria}
        >
          {homeIsDemo ? t.setHome : t.editHome}
        </button>
      )}
    </div>
  );
}

const MODE_ICONS: Record<Mode, keyof typeof UI_ICONS> = {
  near: 'pin',
  weekend: 'sun',
  coffee: 'cup',
};

export function ModeSwitch({ mode, onChange }: { mode: Mode; onChange: (m: Mode) => void }) {
  const t = useT();
  return (
    <div className={`sk flat ${styles.modes}`} role="group" aria-label={t.modesGroup}>
      <Ink />
      {MODES.map((m) => {
        const on = m === mode;
        return (
          <button
            key={m}
            type="button"
            aria-pressed={on}
            className={`tap ${on ? 'sk flat ' : ''}${styles.mode}`}
            onClick={() => {
              onChange(m);
            }}
          >
            {on && <Ink />}
            <Icon name={MODE_ICONS[m]} size={18} strokeWidth={on ? 2.2 : 2} />
            {t.modes[m]}
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
  const t = useT();
  if (chips.length <= 1) return null;
  return (
    <div className={`noscroll ${styles.chips}`} role="group" aria-label={t.cravingGroup}>
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
          <Ink />
          {c === ALL ? t.all : (t.tags[c] ?? c)}
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
  const t = useT();
  return (
    <label className={`sk flat ${styles.search} ${className}`} htmlFor={id}>
      <Ink />
      <Icon name="search" size={20} />
      <span className="visually-hidden">{t.searchLabel}</span>
      <input
        id={id}
        className={styles.searchInput}
        type="search"
        placeholder={t.searchPlaceholder}
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
  const t = useT();
  // remounting the icon (new key) replays the wiggle on every roll
  const [rolls, setRolls] = useState(0);
  const roll = () => {
    setRolls((n) => n + 1);
    onRoll();
  };
  if (big) {
    return (
      <button
        type="button"
        className={`sk press boil ${styles.diceBig}`}
        onClick={roll}
        disabled={disabled}
      >
        <Ink boil />
        <span key={rolls} className={rolls ? 'wiggle' : undefined}>
          <Icon name="dice" size={44} strokeWidth={1.8} />
        </span>
        <span>
          <span className={styles.diceBigTitle}>{t.rollTitle}</span>
          <span className={styles.diceBigSub}>{t.rollSub}</span>
        </span>
      </button>
    );
  }
  return (
    <span className={styles.diceTilt}>
      <button
        type="button"
        className={`sk press boil ${styles.diceSmall}`}
        onClick={roll}
        disabled={disabled}
      >
        <Ink boil />
        <span key={rolls} className={rolls ? 'wiggle' : undefined}>
          <Icon name="dice" size={20} strokeWidth={2.1} />
        </span>
        {t.rollSmall}
      </button>
    </span>
  );
}

/** "the dice says…" sticky. Lives in a polite live region so rolls are announced. */
export function RollResult({ view, onClear }: { view: SpotView | null; onClear: () => void }) {
  const location = useLocation();
  const t = useT();
  return (
    <div aria-live="polite">
      {view && (
        <div className={`sk ${styles.roll}`}>
          <Ink />
          <div className={styles.rollBody}>
            <div className={styles.rollKicker}>{t.diceSays}</div>
            <Link
              viewTransition
              className={styles.rollName}
              lang={dataLang(view.spot)}
              to={`/place/${view.spot.id}`}
              state={{ back: location.pathname + location.search }}
            >
              {view.spot.name}
            </Link>
            <div className={styles.rollMeta}>
              {t.minutes(view.travel.minutes)} {t.travelMode[view.travel.mode]} ·{' '}
              <span lang={dataLang(view.spot)}>{view.spot.cuisine}</span>
            </div>
          </div>
          <GoLink spot={view.spot} travel={view.travel} />
          <button
            type="button"
            className={`tap ${styles.closeBtn}`}
            aria-label={t.clearRoll}
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
  const t = useT();
  const items = [
    { to: '/', label: t.navList, icon: 'list' as const, end: true },
    { to: '/radar', label: t.navRadar, icon: 'radar' as const, end: false },
  ];
  return (
    <nav aria-label={t.viewNav} className={`phone-only ${styles.bottomNav}`}>
      <div className={`sk ${styles.bottomNavInner}`}>
        <Ink />
        {items.map((it) => {
          const active = it.end ? location.pathname === '/' : location.pathname.startsWith(it.to);
          return (
            <NavLink
              viewTransition
              key={it.to}
              to={it.to}
              end={it.end}
              className={`tap ${active ? 'sk flat ' : ''}${styles.navItem}`}
            >
              {active && <Ink />}
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
  const t = useT();
  return (
    <div role="status">
      {notice && (
        <div className={`sk ${styles.notice}`}>
          <Ink />
          <p>{t.notices[notice]}</p>
          <button
            type="button"
            className={`tap ${styles.closeBtn}`}
            aria-label={t.dismiss}
            onClick={dismissNotice}
          >
            <Icon name="close" size={18} strokeWidth={2.4} />
          </button>
        </div>
      )}
    </div>
  );
}

const LANG_LABELS: Record<Locale, string> = { en: 'en', 'zh-Hans': '中文' };

/** Small en / 中文 switch for the header row. */
export function LangToggle({ className = '' }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className={`${styles.lang} ${className}`} role="group" aria-label={t.langGroup}>
      {LOCALES.map((l, i) => (
        <span key={l} className={styles.langItem}>
          {i > 0 && <span aria-hidden="true">/</span>}
          <button
            type="button"
            lang={l}
            aria-pressed={locale === l}
            className={`tap ${styles.langBtn}`}
            onClick={() => {
              setLocale(l);
            }}
          >
            {LANG_LABELS[l]}
          </button>
        </span>
      ))}
    </div>
  );
}
