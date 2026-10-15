import type { Photo } from '../contracts/photos';
import { useT } from '../i18n/context';
import { takesFor, useFriendTakes } from '../lib/friends';
import { FriendAvatars } from './FriendAvatars';
import styles from './FriendTakes.module.css';
import { Ink } from './Ink';
import { FriendPhotos } from './PlacePhotos';

/**
 * The place page's "friends' verdicts": each friend who has been, with their
 * good/meh/bad, their one-liner (in their own handwriting voice) and their
 * photos, then a line of faces of friends who want to go too (a friend who
 * wants to go but already has photos of it gets a line of their own, for the
 * photos). Nothing when no friend has it.
 */
export function FriendTakes({
  placeId,
  photos = {},
}: {
  placeId: string;
  /** Friends' photos of this place, by friend id. */
  photos?: Readonly<Record<string, readonly Photo[]>>;
}) {
  const t = useT();
  const { takes } = useFriendTakes();
  const { been: beenOnly, want } = takesFor(takes, placeId);
  const been = [...beenOnly, ...want.filter((w) => photos[w.friend.id]?.length)];
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
                    {take.status === 'want'
                      ? t.wantToTry
                      : take.verdict
                        ? t.verdicts[take.verdict]
                        : t.friends.noVerdict}
                  </span>
                </span>
                {take.note && (
                  <span className={`note ${styles.note}`} lang={take.lang ?? 'en'}>
                    “{take.note}”
                  </span>
                )}
                <FriendPhotos
                  name={take.friend.displayName}
                  photos={photos[take.friend.id] ?? []}
                />
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
