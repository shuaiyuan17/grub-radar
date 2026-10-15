import { useT } from '../i18n/context';
import { takesFor, useFriendTakes } from '../lib/friends';
import { FriendAvatars } from './FriendAvatars';
import styles from './FriendTakes.module.css';
import { Ink } from './Ink';

/**
 * The place page's "friends' verdicts": each friend who has been, with their
 * good/meh/bad and their one-liner (in their own handwriting voice), then a
 * line of faces of friends who want to go too. Nothing when no friend has it.
 */
export function FriendTakes({ placeId }: { placeId: string }) {
  const t = useT();
  const { takes } = useFriendTakes();
  const { been, want } = takesFor(takes, placeId);
  if (been.length === 0 && want.length === 0) return null;
  return (
    <section aria-labelledby="friend-takes" className={`sk ${styles.box}`}>
      <Ink />
      <h2 id="friend-takes" className={styles.title}>
        {t.friends.takesTitle}
      </h2>
      {been.length > 0 && (
        <ul className={styles.list}>
          {been.map((take, i) => (
            <li key={take.friend.id} className={`enter ${styles.take}`} style={{ '--i': i }}>
              <span className={styles.face} aria-hidden="true">
                {take.friend.avatarEmoji}
              </span>
              <span className={styles.body}>
                <span className={styles.who}>
                  <span className={styles.name}>{take.friend.displayName}</span>
                  <span className={styles.verdict}>
                    {take.verdict ? t.verdicts[take.verdict] : t.friends.noVerdict}
                  </span>
                </span>
                {take.note && (
                  <span className={`note ${styles.note}`} lang={take.lang ?? 'en'}>
                    “{take.note}”
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {want.length > 0 && (
        <p className={styles.want}>
          {t.friends.alsoWant} <FriendAvatars people={want.map((w) => w.friend)} max={5} />
        </p>
      )}
    </section>
  );
}
