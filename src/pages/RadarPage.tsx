import { Ink } from '../components/Ink';
import { Link, useLocation, useSearchParams } from 'react-router';
import { CuisineText, GoLink, PriceText } from '../components/bits';
import { BottomNav, DiceButton } from '../components/controls';
import { FoodTile } from '../components/Icon';
import { KindMark, Radar } from '../components/Radar';
import { dataLang, KINDS, type Kind } from '../domain/spot';
import { useOrigin } from '../lib/origin';
import { roll } from '../domain/roll';
import { findNearby } from '../domain/nearby';
import { isRing, MAX_RING, maxMinutesForRing, type Ring } from '../domain/travel';
import { useSpots } from '../lib/spots';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';
import { Headline } from '../components/bits';
import { useSpotViews } from '../lib/useSpotViews';
import styles from './RadarPage.module.css';

function parseReach(raw: string | null): Ring {
  if (raw === null || raw.trim() === '') return MAX_RING; // Number('') would be 0
  const n = Number(raw);
  return isRing(n) ? n : MAX_RING;
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

  const t = useT();

  return (
    <main id="main" className={styles.main}>
      <div className={styles.layout}>
        <div className={styles.panel}>
          <Link viewTransition to="/" className={`desktop-only ${styles.backLink}`}>
            {t.backToListArrow}
          </Link>
          <Headline className={styles.title} parts={parseHeadline(t.radarHeadline)} />
          <label className={styles.reachRow} htmlFor="reach">
            <span>{t.upTo}</span>
            <input
              id="reach"
              className={styles.reach}
              type="range"
              min={0}
              max={MAX_RING}
              step={1}
              value={reach}
              aria-valuetext={t.ringLabels[reach]}
              onChange={(e) => {
                const n = Number(e.target.value);
                update({ reach: isRing(n) && n !== MAX_RING ? String(n) : null });
              }}
            />
            <span className={styles.reachValue} aria-hidden="true">
              {t.ringLabels[reach]}
            </span>
          </label>

          <div className={styles.legend} role="group" aria-label={t.kindsGroup}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className={`tap ${styles.kind}`}
                aria-pressed={kinds.has(k)}
                onClick={() => {
                  toggleKind(k);
                }}
              >
                <KindMark kind={k} size="tiny" />
                {t.kinds[k]}
              </button>
            ))}
            <span className={styles.inReach} aria-live="polite">
              {t.inReach(inReach.length)}
            </span>
          </div>

          <div aria-live="polite" className={styles.cardSlot}>
            {selected ? (
              <article className={`sk ${styles.card}`} aria-labelledby="radar-card-name">
                <Ink />
                <FoodTile icon={selected.spot.icon} index={selectedIndex} />
                <div className={styles.cardBody}>
                  <Link
                    viewTransition
                    id="radar-card-name"
                    className={styles.cardName}
                    lang={dataLang(selected.spot)}
                    to={`/place/${selected.spot.id}`}
                    state={{ back: location.pathname + location.search }}
                  >
                    {selected.spot.name}
                  </Link>
                  <div className={styles.cardMeta}>
                    <CuisineText spot={selected.spot} /> · <PriceText price={selected.spot.price} />{' '}
                    · {t.minutes(selected.travel.minutes)} {t.travelMode[selected.travel.mode]}
                  </div>
                  {selected.spot.note && (
                    <div className={`note ${styles.cardNote}`} lang={dataLang(selected.spot)}>
                      {selected.spot.note}
                    </div>
                  )}
                </div>
                <GoLink spot={selected.spot} travel={selected.travel} />
              </article>
            ) : spots.length === 0 ? (
              <p className={styles.hint}>
                {t.radarEmpty}{' '}
                <Link viewTransition to="/add">
                  {t.addFirst}
                </Link>
              </p>
            ) : (
              <p className={styles.hint}>{t.radarHint}</p>
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
          <p className="visually-hidden">{t.radarRingsSr(from)}</p>
        </div>
      </div>
      <BottomNav />
    </main>
  );
}
