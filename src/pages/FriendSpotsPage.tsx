import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { StatusBadge } from '../components/bits';
import { BottomNav } from '../components/controls';
import { Ink } from '../components/Ink';
import type { FriendSpotsResponse } from '../contracts/friends';
import { useI18n } from '../i18n/context';
import { ApiRequestError } from '../lib/api';
import { nameOf, useFriendsClient } from '../lib/friends';
import { useSpots } from '../lib/spots';
import styles from './FriendsPage.module.css';

type Load =
  | { state: 'loading' }
  | { state: 'ready'; data: FriendSpotsResponse }
  | { state: 'not-friend' }
  | { state: 'error' };

/**
 * /friends/:id: a friend's list, as they share it with you (friends-visible
 * spots: the place, been/want, verdict, one-liner). Places that are on your
 * list too link to your own page for them.
 */
export function FriendSpotsPage() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const client = useFriendsClient();
  const { spots: mine } = useSpots();
  const [load, setLoad] = useState<{ id: string; load: Load }>({ id, load: { state: 'loading' } });
  const current = load.id === id ? load.load : { state: 'loading' as const };

  useEffect(() => {
    let live = true;
    client.friendSpots(id).then(
      (data) => {
        if (live) setLoad({ id, load: { state: 'ready', data } });
      },
      (e: unknown) => {
        if (!live) return;
        const notFriend = e instanceof ApiRequestError && e.status === 404;
        setLoad({ id, load: notFriend ? { state: 'not-friend' } : { state: 'error' } });
      },
    );
    return () => {
      live = false;
    };
  }, [client, id]);

  const onMine = new Set(mine.map((s) => s.id));

  return (
    <main id="main" className={styles.main}>
      <Link viewTransition to="/friends" className={styles.backLink}>
        {t.friends.backToFriends}
      </Link>
      {current.state === 'loading' && (
        <p className="note" style={{ fontSize: 22 }} aria-busy="true">
          {t.loading}
        </p>
      )}
      {current.state === 'not-friend' && <p className="note">{t.friends.notFriend}</p>}
      {current.state === 'error' && (
        <p role="alert" className="note">
          {t.friends.loadFailed}
        </p>
      )}
      {current.state === 'ready' && (
        <>
          <h1 className={styles.title}>
            <span className={styles.titleCoin} aria-hidden="true">
              {current.data.friend.avatarEmoji}
            </span>{' '}
            {t.friends.theirSpots(nameOf(current.data.friend.displayName, t))}
          </h1>
          {current.data.spots.length === 0 ? (
            <p className={`note ${styles.empty}`}>{t.friends.theirSpotsEmpty}</p>
          ) : (
            <ul className={styles.spots}>
              {current.data.spots.map((s, i) => (
                <li
                  key={s.id}
                  className={`sk lift enter ${styles.spot}`}
                  style={{ '--i': i }}
                  lang={s.lang ?? 'en'}
                >
                  <Ink />
                  <h2 className={styles.spotName}>
                    {onMine.has(s.id) ? (
                      <Link viewTransition to={`/place/${s.id}`}>
                        {s.name}
                      </Link>
                    ) : (
                      s.name
                    )}
                  </h2>
                  <p className={styles.muted}>
                    {s.cuisine ?? <span lang={locale}>{t.kinds[s.kind]}</span>}
                    {s.price && ` · ${s.price}`}
                    {s.address && <span className={styles.address}> · {s.address}</span>}
                  </p>
                  <span className={styles.spotFoot}>
                    <span lang={locale}>
                      <StatusBadge status={s.status} verdict={s.verdict} />
                    </span>
                    {onMine.has(s.id) && (
                      <span className={styles.mineToo} lang={locale}>
                        {t.friends.onYourList}
                      </span>
                    )}
                  </span>
                  {s.note && <p className={`note ${styles.spotNote}`}>{s.note}</p>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <BottomNav />
    </main>
  );
}
