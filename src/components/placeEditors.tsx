import { useId, useState, type SyntheticEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  LIMITS,
  VISIBILITIES,
  dataLang,
  type Spot,
  type Verdict,
  type Visibility,
} from '../domain/spot';
import { parseNoteEntries, type SpotPatch } from '../domain/edits';
import { useT } from '../i18n/context';
import { saveErrorMessage } from '../lib/errors';
import { localDate, useSpots, type SpotActions } from '../lib/spots';
import { Choice, InkBox, InkButton, VerdictPicker } from './fields';
import { formErrorClass, inputClass, linkButtonClass } from './fieldClasses';
import { Icon } from './Icon';
import { Ink } from './Ink';
import styles from './placeEditors.module.css';

/**
 * Runs one save at a time and keeps its error. `run` resolves true when the
 * write went through.
 */
function useSave() {
  const t = useT();
  const { actions } = useSpots();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (write: (a: SpotActions) => Promise<unknown>): Promise<boolean> => {
    if (!actions || busy) return false;
    setBusy(true);
    setError(null);
    try {
      await write(actions);
      return true;
    } catch (e) {
      setError(saveErrorMessage(e, t));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run, canWrite: actions !== null };
}

function SaveError({ error }: { error: string | null }) {
  return (
    <div aria-live="assertive">
      {error && (
        <p role="alert" className={formErrorClass}>
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * Been / want to try, and the verdict. Want: "mark as been" opens a small
 * panel (verdict stamps + an optional dated note). Been: change the verdict, or move
 * it back to want to try.
 */
export function StatusEditor({ spot }: { spot: Spot }) {
  const t = useT();
  const { busy, error, run, canWrite } = useSave();
  const [open, setOpen] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(spot.verdict ?? null);
  const [note, setNote] = useState('');
  const noteId = useId();
  if (!canWrite) return null;

  const close = () => {
    setOpen(false);
    setNote('');
  };

  const markBeen = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const ok = await run((a) =>
      a.markBeen(spot.id, {
        on: localDate(),
        ...(verdict !== null ? { verdict } : {}),
        ...(note.trim() ? { note: note.trim() } : {}),
      }),
    );
    if (ok) close();
  };

  if (spot.status === 'want') {
    return (
      <section className={styles.block} aria-label={t.markBeen}>
        {!open ? (
          <InkButton
            primary
            onClick={() => {
              setOpen(true);
            }}
          >
            <Icon name="check" size={18} strokeWidth={2.6} />
            {t.markBeen}
          </InkButton>
        ) : (
          <form className={`sk ${styles.panel}`} onSubmit={(e) => void markBeen(e)}>
            <Ink />
            <h2 className={styles.panelTitle}>{t.howWasIt}</h2>
            <VerdictPicker value={verdict} onChange={setVerdict} />
            <label htmlFor={noteId} className={styles.label}>
              {t.anythingToRemember}
            </label>
            <InkBox tall>
              <textarea
                id={noteId}
                className={`${inputClass} ${styles.noteArea}`}
                value={note}
                maxLength={LIMITS.entry}
                rows={2}
                onChange={(e) => {
                  setNote(e.target.value);
                }}
              />
            </InkBox>
            <SaveError error={error} />
            <div className={styles.row}>
              <InkButton type="submit" primary busy={busy} disabled={busy}>
                {busy ? t.form.saving : t.form.save}
              </InkButton>
              <button type="button" className={linkButtonClass} onClick={close}>
                {t.form.cancel}
              </button>
            </div>
          </form>
        )}
      </section>
    );
  }

  return (
    <section className={styles.block} aria-label={t.changeVerdict}>
      {open ? (
        <div className={`sk ${styles.panel}`}>
          <Ink />
          <VerdictPicker
            value={verdict}
            onChange={(r) => {
              setVerdict(r);
              void run((a) => a.update(spot.id, { verdict: r, version: spot.version })).then(
                (ok) => {
                  if (ok) setOpen(false);
                },
              );
            }}
          />
          <SaveError error={error} />
          <div className={styles.row}>
            {spot.verdict !== undefined && (
              <button
                type="button"
                className={linkButtonClass}
                disabled={busy}
                onClick={() => {
                  setVerdict(null);
                  void run((a) => a.update(spot.id, { verdict: null, version: spot.version })).then(
                    (ok) => {
                      if (ok) setOpen(false);
                    },
                  );
                }}
              >
                {t.clearVerdict}
              </button>
            )}
            <button
              type="button"
              className={linkButtonClass}
              onClick={() => {
                setOpen(false);
              }}
            >
              {t.form.cancel}
            </button>
          </div>
        </div>
      ) : (
        <div className={styles.row}>
          <button
            type="button"
            className={linkButtonClass}
            onClick={() => {
              setVerdict(spot.verdict ?? null);
              setOpen(true);
            }}
          >
            {t.changeVerdict}
          </button>
          <button
            type="button"
            className={linkButtonClass}
            disabled={busy}
            onClick={() =>
              void run((a) => a.update(spot.id, { status: 'want', version: spot.version }))
            }
          >
            {t.backToWant}
          </button>
        </div>
      )}
      {!open && <SaveError error={error} />}
    </section>
  );
}

function CheckBox({ checked, variant }: { checked: boolean; variant: number }) {
  const boxes = [
    'M4 5.5c5-.8 11-1 17-.3.8 5 .6 10.5-.2 15.6-5.4.6-11 .5-16.3-.1C3.8 15.6 3.6 10.5 4 5.5z',
    'M4.3 5c5.3-.5 11-.6 16.8.2.6 5.2.5 10.6-.3 15.5-5.3.7-10.8.6-16.2 0-.7-5.3-.8-10.6-.3-15.7z',
    'M4 5.3c5.6-.6 11.3-.4 16.9.1.5 5.1.6 10.3-.1 15.4-5.5.6-11 .7-16.4.1C3.6 15.7 3.5 10.4 4 5.3z',
  ];
  return (
    <svg
      width="26"
      height="26"
      viewBox="0 0 26 26"
      fill="none"
      stroke="var(--ink)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={boxes[variant % boxes.length]} />
      {checked && <path d="M8 13.5l3.6 4L22 4.5" stroke="var(--note-red)" strokeWidth="2.6" />}
    </svg>
  );
}

/** "order this": tick dishes off as you try them, add and remove dishes. */
export function OrderEditor({ spot }: { spot: Spot }) {
  const t = useT();
  const { busy, error, run, canWrite } = useSave();
  const [dish, setDish] = useState('');
  const inputId = useId();
  const lang = dataLang(spot);
  const full = spot.order.length >= LIMITS.dishes;

  // the whole list, made from this copy; its version makes a stale copy a 409, not an overwrite
  const save = (order: NonNullable<SpotPatch['order']>) =>
    run((a) => a.update(spot.id, { order, version: spot.version }));

  const add = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const name = dish.trim();
    if (!name || full) return;
    if (spot.order.some((o) => o.dish === name)) {
      setDish('');
      return;
    }
    if (await save([...spot.order, { dish: name, tried: false }])) setDish('');
  };

  return (
    <section aria-labelledby="order" className={styles.section}>
      <h2 id="order">{t.orderThis}</h2>
      {spot.order.length === 0 ? (
        <p className={styles.muted}>{t.orderEmpty}</p>
      ) : (
        <ul className={styles.orderList}>
          {spot.order.map((o, i) => (
            <li key={o.id}>
              {canWrite ? (
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={o.tried}
                  className={`tap ${styles.check}`}
                  disabled={busy}
                  onClick={() =>
                    void save(
                      spot.order.map((x) => (x.id === o.id ? { ...x, tried: !x.tried } : x)),
                    )
                  }
                >
                  <CheckBox checked={o.tried} variant={i} />
                  <span lang={lang}>{o.dish}</span>
                </button>
              ) : (
                <span className={styles.check}>
                  <CheckBox checked={o.tried} variant={i} />
                  <span lang={lang}>{o.dish}</span>
                </span>
              )}
              {o.tried ? (
                <span className="visually-hidden">{t.hadIt}</span>
              ) : (
                <span className={styles.nextTime}>{t.nextTime}</span>
              )}
              {canWrite && (
                <button
                  type="button"
                  className={`tap ${styles.remove}`}
                  aria-label={t.removeDish(o.dish)}
                  disabled={busy}
                  onClick={() => void save(spot.order.filter((x) => x.id !== o.id))}
                >
                  <Icon name="close" size={14} strokeWidth={2.4} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && !full && (
        <form className={styles.inline} onSubmit={(e) => void add(e)}>
          <label htmlFor={inputId} className="visually-hidden">
            {t.addDish}
          </label>
          <span className={styles.grow}>
            <InkBox>
              <input
                id={inputId}
                className={inputClass}
                value={dish}
                maxLength={LIMITS.dish}
                autoComplete="off"
                placeholder={t.addDish}
                onChange={(e) => {
                  setDish(e.target.value);
                }}
              />
            </InkBox>
          </span>
          <InkButton type="submit" disabled={busy || !dish.trim()}>
            {t.add}
          </InkButton>
        </form>
      )}
      <SaveError error={error} />
    </section>
  );
}

/** "my note": dated entries, newest last, and a box to add one more. */
export function NotesEditor({ spot }: { spot: Spot }) {
  const t = useT();
  const { busy, error, run, canWrite } = useSave();
  const [note, setNote] = useState('');
  const [empty, setEmpty] = useState(false);
  const areaId = useId();
  const entries = parseNoteEntries(spot.myNote);
  const lang = dataLang(spot);

  const add = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!note.trim()) {
      setEmpty(true);
      return;
    }
    if (await run((a) => a.addNote(spot.id, { note: note.trim(), on: localDate() }))) setNote('');
  };

  return (
    <section aria-labelledby="mine" className={styles.section}>
      <h2 id="mine">{t.myNote}</h2>
      {entries.length === 0 ? (
        <p className={styles.myNote}>{t.noNoteYet}</p>
      ) : (
        <ul className={styles.entries}>
          {entries.map((entry, i) => (
            <li key={i}>
              {entry.on && <span className={styles.date}>{t.formatDate(entry.on)}</span>}
              <span className={styles.myNote} lang={lang}>
                {entry.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form className={styles.noteForm} onSubmit={(e) => void add(e)}>
          <label htmlFor={areaId} className="visually-hidden">
            {t.addNoteLabel}
          </label>
          <InkBox tall>
            <textarea
              id={areaId}
              className={`${inputClass} ${styles.noteArea}`}
              value={note}
              rows={2}
              maxLength={LIMITS.entry}
              placeholder={t.addNote}
              aria-invalid={empty}
              onChange={(e) => {
                setNote(e.target.value);
                setEmpty(false);
              }}
            />
          </InkBox>
          {empty && (
            <p role="alert" className={formErrorClass}>
              {t.noteEmpty}
            </p>
          )}
          <SaveError error={error} />
          <div>
            <InkButton type="submit" busy={busy} disabled={busy}>
              {busy ? t.form.saving : t.addNote}
            </InkButton>
          </div>
        </form>
      )}
    </section>
  );
}

/** Edit and delete (with a second, explicit "yes, delete"). */
export function SpotAdmin({ spot }: { spot: Spot }) {
  const t = useT();
  const navigate = useNavigate();
  const { busy, error, run, canWrite } = useSave();
  const [confirming, setConfirming] = useState(false);
  if (!canWrite) return null;
  return (
    <div className={styles.admin}>
      <div className={styles.row}>
        <Link
          viewTransition
          to={`/place/${spot.id}/edit`}
          className={`sk press ${styles.smallBtn}`}
          aria-label={t.editAria}
        >
          <Ink />
          {t.edit}
        </Link>
        {!confirming && (
          <button
            type="button"
            className={linkButtonClass}
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t.delete}
          </button>
        )}
      </div>
      {confirming && (
        <div className={`sk ${styles.panel} ${styles.confirm}`} role="group" aria-label={t.delete}>
          <Ink />
          <p>{t.deleteConfirm}</p>
          <SaveError error={error} />
          <div className={styles.row}>
            <InkButton
              primary
              busy={busy}
              disabled={busy}
              onClick={() =>
                void run((a) => a.remove(spot.id)).then((ok) => {
                  if (ok) void navigate('/', { replace: true, viewTransition: true });
                })
              }
            >
              {t.deleteYes}
            </InkButton>
            <button
              type="button"
              className={linkButtonClass}
              onClick={() => {
                setConfirming(false);
              }}
            >
              {t.deleteNo}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Who else sees this spot: friends (the default) or just you. Friends only
 * ever see the place, your verdict and your one-liner; the Worker enforces
 * that and this setting in SQL.
 */
export function VisibilityEditor({ spot }: { spot: Spot }) {
  const t = useT();
  const { busy, error, run, canWrite } = useSave();
  // the tap shows at once; the saved spot takes over when the server answers (or it reverts)
  const [chosen, setChosen] = useState<Visibility | null>(null);
  if (!canWrite) return null;
  const saved = spot.visibility ?? 'friends';
  const value = chosen ?? saved;
  return (
    <section className={styles.block} aria-busy={busy}>
      <Choice
        legend={t.friends.visibilityGroup}
        options={VISIBILITIES.map((v) => ({ value: v, label: t.friends.visibility[v] }))}
        value={value}
        onChange={(visibility) => {
          if (busy || visibility === value) return;
          setChosen(visibility);
          void run((a) => a.update(spot.id, { visibility, version: spot.version })).finally(() => {
            setChosen(null);
          });
        }}
      />
      <p className={styles.muted}>{t.friends.visibilityHint[value]}</p>
      <SaveError error={error} />
    </section>
  );
}
