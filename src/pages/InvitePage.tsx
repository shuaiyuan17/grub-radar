import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Headline } from '../components/bits';
import { formErrorClass } from '../components/fieldClasses';
import { InkButton } from '../components/fields';
import { Ink } from '../components/Ink';
import { INVITE_ROUTE, type InvitePreview } from '../contracts/friends';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';
import { ApiRequestError } from '../lib/api';
import { saveErrorMessage } from '../lib/errors';
import { useFriendsClient, useFriendTakes } from '../lib/friends';
import { forgetInviteToken, rememberInviteToken, useNoReferrer } from '../lib/inviteToken';
import styles from './FriendsPage.module.css';

type View =
  | { state: 'checking' }
  | { state: 'gone' }
  | { state: 'error' }
  | { state: 'preview'; preview: InvitePreview }
  | { state: 'accepted'; name: string; emoji: string; already: boolean };

/**
 * /invite#<token>: someone sent you a link. Signed out, the login wall shows
 * first (and brings you back here after Sign in with Apple). Then: who sent
 * it, and one button. Accepting makes you friends both ways at once.
 */
export function InvitePage() {
  const { hash } = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const client = useFriendsClient();
  const { refresh } = useFriendTakes();
  useNoReferrer();
  // from the fragment, or kept in this tab across the Apple sign-in round trip
  const [token] = useState(() => rememberInviteToken(hash) ?? '');
  const valid = token !== '';
  const [view, setView] = useState<View>(valid ? { state: 'checking' } : { state: 'gone' });

  // once kept, take it out of the address bar (and this history entry)
  useEffect(() => {
    if (hash) void navigate(INVITE_ROUTE, { replace: true });
  }, [hash, navigate]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!valid) return;
    let live = true;
    client.preview(token).then(
      (preview) => {
        // A stale answer (the tab has moved on to another invite) must not
        // forget the token the tab is holding now.
        if (!live) return;
        setView({ state: 'preview', preview });
        if (preview.state !== 'open') forgetInviteToken();
      },
      (e: unknown) => {
        if (!live) return;
        const gone = e instanceof ApiRequestError && e.code === 'invite_gone';
        if (gone) forgetInviteToken();
        setView(gone ? { state: 'gone' } : { state: 'error' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, token, valid]);

  const accept = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await client.accept(token);
      forgetInviteToken();
      setView({
        state: 'accepted',
        name: res.friend.displayName,
        emoji: res.friend.avatarEmoji,
        already: res.already,
      });
      refresh();
    } catch (e) {
      if (e instanceof ApiRequestError && e.code === 'invite_gone') {
        forgetInviteToken();
        setView({ state: 'gone' });
      } else setError(saveErrorMessage(e, t));
    } finally {
      setBusy(false);
    }
  };

  const toFriends = (
    <Link viewTransition to="/friends" className={styles.seeLink}>
      {t.friends.toFriends}
    </Link>
  );

  return (
    <main id="main" className={styles.main}>
      <Headline className={styles.title} parts={parseHeadline(t.friends.inviteTitle)} />
      <section className={`sk ${styles.panel} ${styles.inviteCard}`} aria-live="polite">
        <Ink />
        {view.state === 'checking' && (
          <p className="note" aria-busy="true">
            {t.friends.checking}
          </p>
        )}
        {view.state === 'gone' && <p>{t.friends.gone}</p>}
        {view.state === 'error' && <p role="alert">{t.friends.loadFailed}</p>}
        {view.state === 'preview' && (
          <>
            <span className={`${styles.bigCoin} ${styles.pop}`} aria-hidden="true">
              {view.preview.from.avatarEmoji}
            </span>
            {view.preview.state === 'open' && (
              <>
                <p className={styles.lead}>{t.friends.invitedBy(view.preview.from.displayName)}</p>
                <p className={styles.muted}>{t.friends.inviteExplain}</p>
                <div>
                  <InkButton primary busy={busy} disabled={busy} onClick={() => void accept()}>
                    {busy ? t.friends.accepting : t.friends.accept}
                  </InkButton>
                </div>
                {error && (
                  <p role="alert" className={formErrorClass}>
                    {error}
                  </p>
                )}
              </>
            )}
            {view.preview.state === 'own' && (
              <>
                <p className={styles.lead}>{t.friends.ownInvite}</p>
                {toFriends}
              </>
            )}
            {view.preview.state === 'friends' && (
              <>
                <p className={styles.lead}>
                  {t.friends.alreadyFriends(view.preview.from.displayName)}
                </p>
                {toFriends}
              </>
            )}
          </>
        )}
        {view.state === 'accepted' && (
          <>
            <span className={`${styles.bigCoin} ${styles.pop}`} aria-hidden="true">
              {view.emoji}
            </span>
            <p className={styles.lead} role="status">
              {view.already ? t.friends.alreadyFriends(view.name) : t.friends.accepted(view.name)}
            </p>
            {toFriends}
          </>
        )}
      </section>
    </main>
  );
}
