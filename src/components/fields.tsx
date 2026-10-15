import { useId, type ReactNode } from 'react';
import { VERDICTS, type Verdict } from '../domain/spot';
import { useT } from '../i18n/context';
import styles from './fields.module.css';
import { Ink } from './Ink';

/** A labelled control with an optional hint and error, wired up for screen readers. */
export function Field({
  label,
  hint,
  error,
  optional = false,
  children,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  optional?: boolean;
  /** Receives the ids to put on the control. */
  children: (ids: { id: string; describedBy: string | undefined; invalid: boolean }) => ReactNode;
}) {
  const t = useT();
  const id = useId();
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(' ');
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
        {optional && <span className={styles.optional}> {t.form.optional}</span>}
      </label>
      {children({ id, describedBy: describedBy || undefined, invalid: Boolean(error) })}
      {hint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The hand-drawn frame around a text input or textarea. */
export function InkBox({ children, tall = false }: { children: ReactNode; tall?: boolean }) {
  return (
    <span className={`sk flat ${styles.box} ${tall ? styles.tall : ''}`}>
      <Ink />
      {children}
    </span>
  );
}

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Accessible name when the visible label is an icon. */
  aria?: string;
}

/**
 * One-of-many as real radio buttons (arrow keys, form semantics), drawn as
 * hand-drawn pills. `stamp` for the good / meh / bad verdict stamps.
 */
export function Choice<T extends string>({
  legend,
  options,
  value,
  onChange,
  stamp = false,
  hideLegend = false,
}: {
  legend: string;
  options: readonly ChoiceOption<T>[];
  value: T | null;
  onChange: (value: T) => void;
  stamp?: boolean;
  hideLegend?: boolean;
}) {
  const name = useId();
  return (
    <fieldset className={styles.choice}>
      <legend className={hideLegend ? 'visually-hidden' : styles.label}>{legend}</legend>
      <div className={`${styles.options} ${stamp ? styles.stamps : ''}`}>
        {options.map((o) => {
          const on = o.value === value;
          return (
            <label key={o.value} className={`sk flat ${styles.option} ${on ? styles.on : ''}`}>
              <Ink />
              <input
                type="radio"
                className="visually-hidden"
                name={name}
                value={o.value}
                checked={on}
                aria-label={o.aria}
                onChange={() => {
                  onChange(o.value);
                }}
              />
              {o.label}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/**
 * How it was: three hand-drawn stamps you tap (radio buttons underneath), not
 * a slider or a score.
 */
export function VerdictPicker({
  value,
  onChange,
}: {
  value: Verdict | null;
  onChange: (verdict: Verdict) => void;
}) {
  const t = useT();
  return (
    <Choice
      legend={t.verdictGroup}
      stamp
      options={VERDICTS.map((v) => ({ value: v, label: t.verdicts[v] }))}
      value={value}
      onChange={onChange}
    />
  );
}

/** Ink button: `primary` is the dark one. */
export function InkButton({
  children,
  primary = false,
  type = 'button',
  onClick,
  disabled,
  busy,
}: {
  children: ReactNode;
  primary?: boolean;
  type?: 'button' | 'submit';
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      className={`sk press ${styles.btn} ${primary ? styles.primary : ''}`}
      onClick={onClick}
      disabled={disabled}
      aria-busy={busy}
    >
      <Ink />
      {children}
    </button>
  );
}
