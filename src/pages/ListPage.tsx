import { Ink } from '../components/Ink';
import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Headline, Logo } from '../components/bits';
import {
  BottomNav,
  ChipRow,
  DiceButton,
  FromToggle,
  ModeSwitch,
  RollResult,
  SearchBox,
} from '../components/controls';
import { Icon } from '../components/Icon';
import { Radar } from '../components/Radar';
import { SpotCard } from '../components/SpotCard';
import { ALL, isMode, listSpots, MODE_DEFS, type Mode } from '../domain/modes';
import { useOrigin } from '../lib/origin';
import { roll } from '../domain/roll';
import { getPageHeadline } from '../lib/pageHeadline';
import { useSpotViews } from '../lib/useSpotViews';
import styles from './ListPage.module.css';

let headlineDrawn = false;

type ParamPatch = Partial<Record<'mode' | 'tag' | 'q' | 'roll', string | null>>;

export function ListPage() {
  const [params, setParams] = useSearchParams();
  const { from, origin, chooseHere } = useOrigin();
  const views = useSpotViews();

  // picked once per page load from the local time (see domain/headlines.ts)
  const opening = getPageHeadline();
  const modeParam = params.get('mode');
  const mode: Mode = isMode(modeParam) ? modeParam : opening.defaultMode;
  const q = params.get('q') ?? '';
  const rollId = params.get('roll');
  const result = listSpots(views, { mode, tag: params.get('tag') ?? ALL, q });
  // an unknown or stale ?roll= id simply shows no roll
  const rolled = rollId ? (result.items.find((v) => v.spot.id === rollId) ?? null) : null;
  const def = MODE_DEFS[mode];

  const [searchOpen, setSearchOpen] = useState(q !== '');
  // the highlighter draws in on the first list render of this page load only
  const [drawHeadline] = useState(() => !headlineDrawn);
  useEffect(() => {
    headlineDrawn = true;
  }, []);

  // a roll was "in range" of the old origin; moving invalidates it
  const lastOrigin = useRef(origin);
  useEffect(() => {
    if (lastOrigin.current === origin) return;
    lastOrigin.current = origin;
    setParams(
      (prev) => {
        if (!prev.has('roll')) return prev;
        const next = new URLSearchParams(prev);
        next.delete('roll');
        return next;
      },
      { replace: true },
    );
  }, [origin, setParams]);

  const update = (patch: ParamPatch) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          // a mode you pick is always written (?mode=near), even if it's today's default
          if (v === null || v === '' || (k === 'tag' && v === ALL)) {
            next.delete(k);
          } else {
            next.set(k, v);
          }
        }
        return next;
      },
      { replace: true },
    );
  };

  const rollDice = () => {
    const pick = roll(
      result.items.map((v) => ({ id: v.spot.id })),
      rollId,
    );
    if (pick) update({ roll: pick.id });
  };
  const clearRoll = () => {
    update({ roll: null });
  };

  const n = result.items.length;
  const countLabel = result.searching
    ? `${n} ${n === 1 ? 'match' : 'matches'} · closest first`
    : `${n} ${n === 1 ? 'spot' : 'spots'} · ${def.sortLabel}`;

  return (
    <main id="main" className={styles.main}>
      <div className={`phone-only ${styles.phoneHeader}`}>
        <Logo />
        <div className={styles.phoneHeaderBtns}>
          <button
            type="button"
            className={`sk press ${styles.iconBtn}`}
            aria-label="Search my spots"
            aria-expanded={searchOpen}
            aria-controls="search-phone-row"
            onClick={() => {
              if (searchOpen && q) update({ q: null }); // closing search clears it
              setSearchOpen(!searchOpen);
            }}
          >
            <Ink />
            <Icon name="search" size={21} />
          </button>
          <button
            type="button"
            className={`sk press ${styles.iconBtn}`}
            aria-label="Use my current location"
            onClick={chooseHere}
          >
            <Ink />
            <Icon name="locate" size={22} strokeWidth={2} />
          </button>
        </div>
      </div>

      <div className="phone-only">
        <FromToggle />
      </div>

      {searchOpen && (
        <div id="search-phone-row" className="phone-only">
          <SearchBox
            id="search-phone"
            autoFocus
            value={q}
            onChange={(value) => {
              update({ q: value, roll: null });
            }}
          />
        </div>
      )}

      <div className={styles.titleRow}>
        <Headline
          parts={mode === opening.defaultMode ? opening.parts : def.headline}
          className={styles.title}
          draw={drawHeadline}
        />
        <ModeSwitch
          mode={mode}
          onChange={(m) => {
            update({ mode: m, tag: null, roll: null, q: null });
          }}
        />
      </div>

      <ChipRow
        chips={result.chips}
        value={result.tag}
        onChange={(tag) => {
          update({ tag, roll: null });
        }}
      />

      <div className={styles.columns}>
        <section aria-label="Places" className={styles.listCol}>
          <div className={styles.countRow}>
            <span className={styles.count} aria-live="polite">
              {countLabel}
            </span>
            <span className="phone-only">
              <DiceButton onRoll={rollDice} disabled={n === 0} />
            </span>
          </div>

          <div className="phone-only">
            <RollResult view={rolled} onClear={clearRoll} />
          </div>

          {n === 0 ? (
            <p className={`note ${styles.empty}`}>
              {result.searching ? `nothing matches “${q.trim()}”.` : def.emptyHint}
            </p>
          ) : (
            // keyed by mode + chip so the cards stagger in again when they change
            <ul className={styles.cards} key={`${mode}|${result.tag}|${String(result.searching)}`}>
              {result.items.map((v, i) => (
                <li key={v.spot.id} className="enter" style={{ '--i': i }}>
                  <SpotCard view={v} index={i} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Radar and dice" className={`desktop-only ${styles.aside}`}>
          {/* top of the aside so the pick is on screen right after rolling */}
          <RollResult view={rolled} onClear={clearRoll} />
          <div className={`sk ${styles.radarCard}`}>
            <Ink />
            <div className={styles.radarCardHead}>
              <h2>around {from === 'home' ? 'home' : 'you'}</h2>
              <span className="note">rings = travel time</span>
            </div>
            <Radar views={views} from={from} className={styles.miniRadar} />
            <Link viewTransition to="/radar" className={styles.radarLink}>
              open the full radar
            </Link>
          </div>
          <div className={styles.diceWrap}>
            <DiceButton big onRoll={rollDice} disabled={n === 0} />
          </div>
        </aside>
      </div>

      <BottomNav />
    </main>
  );
}
