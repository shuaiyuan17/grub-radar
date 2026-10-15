import { useState } from 'react';
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

type ParamPatch = Partial<Record<'mode' | 'tag' | 'q' | 'roll', string | null>>;

export function ListPage() {
  const [params, setParams] = useSearchParams();
  const { from, chooseHere } = useOrigin();
  const views = useSpotViews();

  // picked once per page load from the local time (see domain/headlines.ts)
  const opening = getPageHeadline();
  const modeParam = params.get('mode');
  const mode: Mode = isMode(modeParam) ? modeParam : opening.defaultMode;
  const q = params.get('q') ?? '';
  const rollId = params.get('roll');
  const result = listSpots(views, { mode, tag: params.get('tag') ?? ALL, q });
  const rolled = rollId ? (result.items.find((v) => v.spot.id === rollId) ?? null) : null;
  const def = MODE_DEFS[mode];

  const [searchOpen, setSearchOpen] = useState(q !== '');

  const update = (patch: ParamPatch) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        for (const [k, v] of Object.entries(patch)) {
          if (
            v === null ||
            v === '' ||
            (k === 'mode' && v === opening.defaultMode) ||
            (k === 'tag' && v === ALL)
          ) {
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
    update({ roll: pick?.id ?? 'none' });
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
              setSearchOpen((o) => !o);
            }}
          >
            <Icon name="search" size={21} />
          </button>
          <button
            type="button"
            className={`sk press ${styles.iconBtn}`}
            aria-label="Use my current location"
            onClick={chooseHere}
          >
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
            <RollResult view={rolled} rolled={rollId !== null} onClear={clearRoll} />
          </div>

          {n === 0 ? (
            <p className={`note ${styles.empty}`}>
              {result.searching ? `nothing matches “${q.trim()}”.` : def.emptyHint}
            </p>
          ) : (
            <ul className={styles.cards}>
              {result.items.map((v, i) => (
                <li key={v.spot.id}>
                  <SpotCard view={v} index={i} />
                </li>
              ))}
            </ul>
          )}
        </section>

        <aside aria-label="Radar and dice" className={`desktop-only ${styles.aside}`}>
          {/* top of the aside so the pick is on screen right after rolling */}
          <RollResult view={rolled} rolled={rollId !== null} onClear={clearRoll} />
          <div className={`sk ${styles.radarCard}`}>
            <div className={styles.radarCardHead}>
              <h2>around {from === 'home' ? 'home' : 'you'}</h2>
              <span className="note">rings = travel time</span>
            </div>
            <Radar views={views} from={from} className={styles.miniRadar} />
            <Link to="/radar" className={styles.radarLink}>
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
