import { useId } from 'react';
import { useT } from '../i18n/context';
import { AVATAR_CHOICES } from '../lib/friends';
import styles from './EmojiPicker.module.css';

/**
 * Your avatar emoji, as a group of real radio buttons (arrow keys, one tab
 * stop) drawn as a grid. Offers a few, plus whatever you have now.
 */
export function EmojiPicker({
  value,
  onChange,
  legend,
  legendClassName,
}: {
  value: string;
  onChange: (emoji: string) => void;
  legend: string;
  legendClassName?: string;
}) {
  const t = useT();
  const groupName = useId();
  // any emoji the server accepts; the grid offers a few, plus whatever you have now
  const choices = AVATAR_CHOICES.includes(value as (typeof AVATAR_CHOICES)[number])
    ? AVATAR_CHOICES
    : [value, ...AVATAR_CHOICES];
  return (
    <fieldset className={styles.grid}>
      <legend className={legendClassName}>{legend}</legend>
      <div className={styles.emojis}>
        {choices.map((e) => (
          <label key={e} className={`tap ${styles.emoji} ${e === value ? styles.on : ''}`}>
            <input
              type="radio"
              className="visually-hidden"
              name={groupName}
              value={e}
              checked={e === value}
              aria-label={t.friends.emojiAria(e)}
              onChange={() => {
                onChange(e);
              }}
            />
            <span aria-hidden="true">{e}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
