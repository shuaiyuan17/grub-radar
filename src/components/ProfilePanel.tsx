import { useId, useState, type SyntheticEvent } from 'react';
import {
  DEFAULT_DISPLAY_NAME,
  DisplayNameSchema,
  DISPLAY_NAME_MAX,
  type MeUser,
} from '../contracts/me';
import { useT } from '../i18n/context';
import { useAuth } from '../lib/auth';
import { saveErrorMessage } from '../lib/errors';
import { AVATAR_CHOICES, useFriendsClient } from '../lib/friends';
import { formErrorClass, inputClass } from './fieldClasses';
import { InkBox, InkButton } from './fields';
import styles from './ProfilePanel.module.css';
import { Ink } from './Ink';

/**
 * How friends see you: your display name and an emoji. Apple sends a name
 * only on the very first sign-in (and not at all if you hid it), so this is
 * where you fix it. Saves with PATCH /api/me.
 */
export function ProfilePanel({ user }: { user: MeUser }) {
  const t = useT();
  const client = useFriendsClient();
  const { setMeUser } = useAuth();
  const [name, setName] = useState(user.displayName);
  const [emoji, setEmoji] = useState(user.avatarEmoji);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const nameId = useId();
  const groupName = useId();
  const unnamed = user.displayName === DEFAULT_DISPLAY_NAME;
  // any emoji the server accepts; the grid offers a few, plus whatever you have now
  const choices = AVATAR_CHOICES.includes(emoji as (typeof AVATAR_CHOICES)[number])
    ? AVATAR_CHOICES
    : [emoji, ...AVATAR_CHOICES];

  const changed = name.trim() !== user.displayName || emoji !== user.avatarEmoji;

  const save = async (e: SyntheticEvent<HTMLFormElement>) => {
    e.preventDefault();
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(t.friends.nameLabel);
      return;
    }
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const next = await client.updateProfile({
        ...(parsed.data !== user.displayName ? { displayName: parsed.data } : {}),
        ...(emoji !== user.avatarEmoji ? { avatarEmoji: emoji } : {}),
      });
      setMeUser(next);
      setName(next.displayName);
      setSaved(true);
    } catch (err) {
      setError(saveErrorMessage(err, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className={`sk ${styles.panel}`} onSubmit={(e) => void save(e)}>
      <Ink />
      <h2 className={styles.title}>{t.friends.profileTitle}</h2>
      <div className={styles.preview} aria-hidden="true">
        <span key={emoji} className={styles.coin}>
          {emoji}
        </span>
        <span className={styles.previewName}>{name.trim() || '…'}</span>
      </div>
      {unnamed && <p className={styles.nudge}>{t.friends.nameNudge}</p>}
      <label htmlFor={nameId} className={styles.label}>
        {t.friends.nameLabel}
      </label>
      <InkBox>
        <input
          id={nameId}
          className={inputClass}
          value={name}
          maxLength={DISPLAY_NAME_MAX * 4}
          autoComplete="nickname"
          onChange={(e) => {
            setName(e.target.value);
            setSaved(false);
          }}
        />
      </InkBox>
      <fieldset className={styles.grid}>
        <legend className={styles.label}>{t.friends.emojiGroup}</legend>
        <div className={styles.emojis}>
          {choices.map((e) => (
            <label key={e} className={`tap ${styles.emoji} ${e === emoji ? styles.on : ''}`}>
              <input
                type="radio"
                className="visually-hidden"
                name={groupName}
                value={e}
                checked={e === emoji}
                aria-label={t.friends.emojiAria(e)}
                onChange={() => {
                  setEmoji(e);
                  setSaved(false);
                }}
              />
              <span aria-hidden="true">{e}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div aria-live="polite" className={styles.status}>
        {error && (
          <p role="alert" className={formErrorClass}>
            {error}
          </p>
        )}
        {saved && <p className={`note ${styles.saved}`}>{t.friends.profileSaved}</p>}
      </div>
      <div>
        <InkButton type="submit" primary busy={busy} disabled={busy || !changed}>
          {busy ? t.friends.savingProfile : t.friends.saveProfile}
        </InkButton>
      </div>
    </form>
  );
}
