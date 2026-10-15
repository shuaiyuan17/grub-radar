import { useId, useState } from 'react';
import { Link } from 'react-router';
import { useT } from '../i18n/context';
import { firstName, useAuth } from '../lib/auth';
import styles from './AccountMenu.module.css';
import { Ink } from './Ink';

/**
 * Who's signed in: avatar emoji (+ first name on desktop), and a small menu
 * with "sign out". Renders nothing when signed out (the wall handles that).
 */
export function AccountMenu({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const { state, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const menuId = useId();
  if (state.status !== 'signed-in') return null;
  const { displayName, avatarEmoji } = state.me.user;
  const name = firstName(displayName);

  return (
    <div
      className={styles.account}
      onKeyDown={(e) => {
        if (e.key === 'Escape') setOpen(false);
      }}
    >
      <button
        type="button"
        className={`sk press ${styles.chip} ${compact ? styles.compact : ''}`}
        aria-label={t.accountLabel(displayName)}
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Ink />
        <span className={styles.avatar} aria-hidden="true">
          {avatarEmoji}
        </span>
        {!compact && (
          <span className={styles.name} aria-hidden="true">
            {name}
          </span>
        )}
      </button>
      {open && (
        <div id={menuId} className={`sk ${styles.menu}`}>
          <Ink />
          <p className={styles.who}>
            <span aria-hidden="true">{avatarEmoji} </span>
            {displayName}
          </p>
          <Link
            to="/settings"
            className={`tap ${styles.menuLink}`}
            onClick={() => {
              setOpen(false);
            }}
          >
            {t.agents.menuLink}
          </Link>
          <button
            type="button"
            className={`tap ${styles.signOut}`}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void signOut();
            }}
          >
            {busy ? t.signingOut : t.signOut}
          </button>
        </div>
      )}
    </div>
  );
}
