import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { FriendTake } from '../contracts/friends';
import { FriendTakesContext, useFriendsClient, type FriendTakesValue } from '../lib/friends';

/**
 * Friends' takes on the places on your list (GET /api/friends/places), asked
 * for once when the app shell mounts and again on `refresh()`. Decoration,
 * not data you need: if it fails, cards simply show no friend avatars.
 */
export function FriendsProvider({ children }: { children: ReactNode }) {
  const client = useFriendsClient();
  const [takes, setTakes] = useState<Record<string, FriendTake[]>>({});
  const [round, setRound] = useState(0);

  useEffect(() => {
    let live = true;
    client.places().then(
      (next) => {
        if (live) setTakes(next);
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [client, round]);

  const refresh = useCallback(() => {
    setRound((r) => r + 1);
  }, []);
  const value = useMemo<FriendTakesValue>(() => ({ takes, refresh }), [takes, refresh]);
  return <FriendTakesContext value={value}>{children}</FriendTakesContext>;
}
