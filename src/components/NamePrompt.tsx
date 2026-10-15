import { useEffect, useId, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { DisplayNameSchema, DISPLAY_NAME_MAX, type MeUser } from '../contracts/me';
import { useT } from '../i18n/context';
import { useAuth } from '../lib/auth';
import { saveErrorMessage } from '../lib/errors';
import { useFriendsClient } from '../lib/friends';
import { LangToggle } from './controls';
import { EmojiPicker } from './EmojiPicker';
import { formErrorClass, inputClass } from './fieldClasses';
import { InkBox, InkButton } from './fields';
import { Ink } from './Ink';
import styles from './NamePrompt.module.css';
import { preventImeEnter } from '../lib/ime';

/** What Tab can land on inside the dialog (a radio group is one stop: its checked radio). */
const TABBABLE =
  'button:not(:disabled), input:not([type="radio"]):not(:disabled), input[type="radio"]:checked';

/**
 * "what should we call you?", before the app, for an account whose name was
 * never chosen: Apple sends a name only on an Apple ID's first authorization
 * (and never when it's hidden), so a retried sign-up gets the stand-in 'you'.
 *
 * Blocking on purpose: friends would otherwise see "you". A modal dialog with
 * focus kept inside; Esc does nothing (the name is required); nothing behind
 * it is rendered at all, so the route it covers (an invite, say) only mounts
 * once the name is saved, and picks up from there. Saves through PATCH
 * /api/me, the same validation and cleaning as the profile panel.
 */
export function NamePrompt({ user }: { user: MeUser }) {
  const t = useT();
  const client = useFriendsClient();
  const { setMeUser } = useAuth();
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState(user.avatarEmoji);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const nameId = useId();
  const errorId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    // focus that wanders out (a click on the page behind) comes straight back
    const keep = (e: FocusEvent) => {
      const d = dialogRef.current;
      if (d && e.target instanceof Node && !d.contains(e.target)) inputRef.current?.focus();
    };
    document.addEventListener('focusin', keep);
    return () => {
      document.removeEventListener('focusin', keep);
    };
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // the name is required: Esc doesn't dismiss
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== 'Tab') return;
    const stops = [...(dialogRef.current?.querySelectorAll<HTMLElement>(TABBABLE) ?? [])];
    const first = stops[0];
    const last = stops.at(-1);
    if (!first || !last) return;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const save = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((i) => i.message === 'name is too long');
      setError(tooLong ? t.namePrompt.tooLong : t.namePrompt.empty);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await client.updateProfile({
        displayName: parsed.data,
        ...(emoji !== user.avatarEmoji ? { avatarEmoji: emoji } : {}),
      });
      // nameSet is true now: the gate swaps this for the app
      setMeUser(next);
    } catch (err) {
      setError(saveErrorMessage(err, t));
      setBusy(false);
    }
  };

  return (
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={hintId}
        className={`sk ${styles.dialog}`}
        onKeyDown={onKeyDown}
      >
        <Ink />
        <div className={styles.lang}>
          <LangToggle />
        </div>
        <form
          className={styles.form}
          noValidate
          onSubmit={(e) => void save(e)}
          onKeyDown={preventImeEnter}
        >
          <span key={emoji} className={styles.coin} aria-hidden="true">
            {emoji}
          </span>
          <h1 id={titleId} className={styles.title}>
            {t.namePrompt.title}
          </h1>
          <p id={hintId} className={`note ${styles.hint}`}>
            {t.namePrompt.hint}
          </p>
          <label htmlFor={nameId} className={styles.label}>
            {t.namePrompt.nameLabel}
          </label>
          <InkBox>
            <input
              ref={inputRef}
              id={nameId}
              className={inputClass}
              value={name}
              required
              maxLength={DISPLAY_NAME_MAX * 4}
              autoComplete="nickname"
              aria-invalid={error !== null}
              aria-describedby={error ? errorId : undefined}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
            />
          </InkBox>
          <EmojiPicker
            value={emoji}
            legend={t.namePrompt.emojiGroup}
            legendClassName={styles.label}
            onChange={setEmoji}
          />
          <div aria-live="polite" className={styles.status}>
            {error && (
              <p id={errorId} role="alert" className={formErrorClass}>
                {error}
              </p>
            )}
          </div>
          <div>
            <InkButton type="submit" primary busy={busy} disabled={busy}>
              {busy ? t.namePrompt.saving : t.namePrompt.save}
            </InkButton>
          </div>
        </form>
      </div>
    </div>
  );
}
