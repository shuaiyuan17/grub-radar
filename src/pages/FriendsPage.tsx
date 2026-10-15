import { useCallback, useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { Headline } from '../components/bits';
import { BottomNav } from '../components/controls';
import { formErrorClass, inputClass, linkButtonClass } from '../components/fieldClasses';
import { InkBox, InkButton } from '../components/fields';
import { Icon } from '../components/Icon';
import { Ink } from '../components/Ink';
import { ProfilePanel } from '../components/ProfilePanel';
import type { CreatedInvite, Friend, PendingInvite } from '../contracts/friends';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';
import { useAuth } from '../lib/auth';
import { saveErrorMessage } from '../lib/errors';
import { inviteUrl, useFriendsClient, useFriendTakes } from '../lib/friends';
import styles from './FriendsPage.module.css';

type ShareResult = 'shared' | 'copied' | 'copyFailed' | null;

/** Web Share where there is one (phones), else the clipboard. Never throws. */
async function shareOrCopy(
  url: string,
  title: string,
  text: string,
  { share = true }: { share?: boolean } = {},
): Promise<ShareResult> {
  if (share && typeof navigator.share === 'function') {
    try {
      await navigator.share({ title, text, url });
      return 'shared';
    } catch (e) {
      // they closed the sheet: the link stays on screen, nothing to say
      if (e instanceof DOMException && e.name === 'AbortError') return null;
      // NotAllowedError (the tap's activation ran out while we made the link) etc.: copy instead
    }
  }
  try {
    await navigator.clipboard.writeText(url);
    return 'copied';
  } catch {
    return 'copyFailed';
  }
}

/**
 * "invite a friend": makes a single-use link, offers it to the share sheet
 * (or copies it), and keeps it on screen. Below, your links still waiting,
 * each revocable.
 */
function InviteBlock({
  pending,
  onMade,
  onRevoked,
}: {
  pending: readonly PendingInvite[] | null;
  onMade: (invite: CreatedInvite) => void;
  onRevoked: (id: string) => void;
}) {
  const t = useT();
  const client = useFriendsClient();
  const { state } = useAuth();
  const [link, setLink] = useState<string | null>(null);
  const [result, setResult] = useState<ShareResult>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const linkId = useId();
  const name = state.status === 'signed-in' ? state.me.user.displayName : '';
  const offer = async (url: string, opts?: { share?: boolean }) => {
    setResult(await shareOrCopy(url, t.friends.shareTitle, t.friends.shareText(name), opts));
  };

  const make = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const made = await client.createInvite();
      const url = inviteUrl(made.path);
      setLink(url);
      onMade(made);
      await offer(url);
    } catch (e) {
      setError(saveErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await client.revokeInvite(id);
      onRevoked(id);
    } catch (e) {
      setError(saveErrorMessage(e, t));
    }
  };

  return (
    <section className={`sk ${styles.panel} ${styles.invite}`} aria-labelledby="invite-title">
      <Ink />
      <h2 id="invite-title" className="visually-hidden">
        {t.friends.invite}
      </h2>
      <InkButton primary busy={busy} disabled={busy} onClick={() => void make()}>
        <Icon name="plus" size={18} strokeWidth={2.6} />
        {busy ? t.friends.inviting : t.friends.invite}
      </InkButton>
      <p className={styles.muted}>{t.friends.inviteHint}</p>
      {link && (
        <div className={`enter ${styles.linkBox}`}>
          <label htmlFor={linkId} className={styles.label}>
            {t.friends.linkReady}
          </label>
          <InkBox>
            <input
              id={linkId}
              className={`${inputClass} ${styles.linkInput}`}
              value={link}
              readOnly
              aria-label={t.friends.linkLabel}
              onFocus={(e) => {
                e.currentTarget.select();
              }}
            />
          </InkBox>
          <div className={styles.row}>
            {typeof navigator.share === 'function' && (
              <InkButton onClick={() => void offer(link)}>
                <Icon name="share" size={17} strokeWidth={2.4} />
                {t.friends.share}
              </InkButton>
            )}
            <InkButton onClick={() => void offer(link, { share: false })}>
              {t.friends.copy}
            </InkButton>
          </div>
        </div>
      )}
      <div aria-live="polite">
        {result && <p className={`note ${styles.result}`}>{t.friends[result]}</p>}
        {error && (
          <p role="alert" className={formErrorClass}>
            {error}
          </p>
        )}
      </div>
      <h3 className={styles.subTitle}>{t.friends.pendingTitle}</h3>
      {pending?.length === 0 && <p className={styles.muted}>{t.friends.pendingNone}</p>}
      {pending && pending.length > 0 && (
        <ul className={styles.pending}>
          {pending.map((inv) => {
            const made = t.formatDate(inv.createdAt);
            return (
              <li key={inv.id}>
                <span>{t.friends.pendingItem(made, t.formatDate(inv.expiresAt))}</span>
                <button
                  type="button"
                  className={linkButtonClass}
                  aria-label={t.friends.revokeAria(made)}
                  onClick={() => void revoke(inv.id)}
                >
                  {t.friends.revoke}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function FriendRow({
  friend,
  index,
  onGone,
}: {
  friend: Friend;
  index: number;
  onGone: (id: string) => void;
}) {
  const t = useT();
  const client = useFriendsClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unfriend = async () => {
    setBusy(true);
    setError(null);
    try {
      await client.unfriend(friend.id);
      onGone(friend.id);
    } catch (e) {
      setError(saveErrorMessage(e, t));
      setBusy(false);
    }
  };
  return (
    <li className={`sk flat enter ${styles.friend}`} style={{ '--i': index }}>
      <Ink />
      <span className={styles.coin} aria-hidden="true">
        {friend.avatarEmoji}
      </span>
      <span className={styles.friendBody}>
        <span className={styles.friendName}>{friend.displayName}</span>
        <span className={styles.muted}>{t.friends.since(t.formatDate(friend.since))}</span>
        <span className={styles.row}>
          <Link
            viewTransition
            to={`/friends/${encodeURIComponent(friend.id)}`}
            aria-label={t.friends.seeSpotsAria(friend.displayName)}
            className={styles.seeLink}
          >
            {t.friends.seeSpots}
          </Link>
          {!confirming && (
            <button
              type="button"
              className={linkButtonClass}
              onClick={() => {
                setConfirming(true);
              }}
            >
              {t.friends.unfriend}
            </button>
          )}
        </span>
        {confirming && (
          <span className={styles.confirm} role="group" aria-label={t.friends.unfriend}>
            <span>{t.friends.unfriendConfirm(friend.displayName)}</span>
            <span className={styles.row}>
              <InkButton primary busy={busy} disabled={busy} onClick={() => void unfriend()}>
                {t.friends.unfriendYes}
              </InkButton>
              <button
                type="button"
                className={linkButtonClass}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                {t.friends.unfriendNo}
              </button>
            </span>
            {error && (
              <span role="alert" className={formErrorClass}>
                {error}
              </span>
            )}
          </span>
        )}
      </span>
    </li>
  );
}

/** /friends: invite someone, your links, your friends, and how they see you. */
export function FriendsPage() {
  const t = useT();
  const client = useFriendsClient();
  const { state } = useAuth();
  const { refresh } = useFriendTakes();
  const [friends, setFriends] = useState<{ list: Friend[]; limit: number } | null>(null);
  const [pending, setPending] = useState<PendingInvite[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;
    Promise.all([client.list(), client.invites()]).then(
      ([list, invites]) => {
        if (!live) return;
        setFriends({ list: list.friends, limit: list.limit });
        setPending(invites);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [client]);

  const onGone = useCallback(
    (id: string) => {
      setFriends((f) => (f ? { ...f, list: f.list.filter((x) => x.id !== id) } : f));
      refresh();
    },
    [refresh],
  );

  if (state.status !== 'signed-in') return null;
  const me = state.me.user;

  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.friends.title)} />
      <p className={styles.intro}>{t.friends.intro}</p>
      {failed && (
        <p role="alert" className={formErrorClass}>
          {t.friends.loadFailed}
        </p>
      )}
      <div className={styles.layout}>
        <div className={styles.col}>
          <InviteBlock
            pending={pending}
            onMade={(made) => {
              setPending((p) => [
                { id: made.id, createdAt: made.createdAt, expiresAt: made.expiresAt },
                ...(p ?? []),
              ]);
            }}
            onRevoked={(id) => {
              setPending((p) => (p ? p.filter((x) => x.id !== id) : p));
            }}
          />
          <ProfilePanel user={me} />
        </div>
        <section className={styles.col} aria-labelledby="friends-title">
          <h2 id="friends-title" className={styles.subTitle}>
            {t.friends.listTitle}
            {friends && (
              <span className={styles.count}>
                {' '}
                · {t.friends.count(friends.list.length, friends.limit)}
              </span>
            )}
          </h2>
          {friends?.list.length === 0 && <p className={`note ${styles.empty}`}>{t.friends.none}</p>}
          {friends && friends.list.length > 0 && (
            <ul className={styles.friends}>
              {friends.list.map((f, i) => (
                <FriendRow key={f.id} friend={f} index={i} onGone={onGone} />
              ))}
            </ul>
          )}
        </section>
      </div>
      <BottomNav />
    </main>
  );
}
