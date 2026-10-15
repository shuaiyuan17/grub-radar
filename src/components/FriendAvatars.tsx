import type { Person } from '../contracts/friends';
import { useT } from '../i18n/context';
import { nameOf } from '../lib/friends';
import styles from './FriendAvatars.module.css';

/**
 * A small stack of friends' emoji avatars, the first `max` of them, then
 * "+N". One accessible name for the lot ("Friends who've been here: …").
 */
export function FriendAvatars({
  people,
  max = 3,
  size = 'small',
}: {
  people: readonly Person[];
  max?: number;
  size?: 'small' | 'big';
}) {
  const t = useT();
  if (people.length === 0) return null;
  // "+1" helps nobody: show the last face instead
  const shown = people.length === max + 1 ? people : people.slice(0, max);
  const extra = people.length - shown.length;
  return (
    <span
      className={`${styles.stack} ${size === 'big' ? styles.big : ''}`}
      role="img"
      aria-label={t.friends.beenAria(people.map((p) => nameOf(p.displayName, t)).join(', '))}
    >
      {shown.map((p, i) => (
        <span
          key={p.id}
          className={styles.avatar}
          style={{ zIndex: shown.length - i, '--i': i }}
          title={nameOf(p.displayName, t)}
          aria-hidden="true"
        >
          {p.avatarEmoji}
        </span>
      ))}
      {extra > 0 && (
        <span className={`${styles.avatar} ${styles.more}`} aria-hidden="true">
          {t.friends.more(extra)}
        </span>
      )}
    </span>
  );
}
