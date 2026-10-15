import { Outlet, useSearchParams } from 'react-router';
import { useT } from '../i18n/context';
import { I18nProvider } from '../i18n/I18nProvider';
import { useAuth } from '../lib/auth';
import { SignInPage } from '../pages/SignInPage';
import styles from './AuthGate.module.css';
import { Logo } from './bits';
import { Icon } from './Icon';
import { Ink } from './Ink';

/**
 * The route root. Signed in: the app. Signed out: the login wall, on every
 * URL. The language switch works on both, so I18nProvider lives here.
 */
export function AuthGate() {
  return (
    <I18nProvider>
      <Gate />
    </I18nProvider>
  );
}

function Gate() {
  const t = useT();
  const { state } = useAuth();
  if (state.status === 'loading') {
    // the shell's first line straight away, not a blank page, while we ask
    return (
      <div className={styles.boot}>
        <Logo />
        <p className="note" style={{ fontSize: 22 }} aria-busy="true">
          {t.checkingWho}
        </p>
      </div>
    );
  }
  if (state.status === 'signed-out') return <SignInPage />;
  return (
    <>
      <AlreadySignedIn />
      <Outlet />
    </>
  );
}

/**
 * `?signin=already`: a sign-in that couldn't be tied to this browser was
 * refused because this browser already has a session (worker/routes/auth.ts).
 * A gentle note over the app, dismissible; nothing changed.
 */
function AlreadySignedIn() {
  const t = useT();
  const [params, setParams] = useSearchParams();
  if (params.get('signin') !== 'already') return null;
  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete('signin');
    setParams(next, { replace: true });
  };
  return (
    <div role="status" className={`sk ${styles.notice}`}>
      <Ink />
      <p>{t.signinResult.already}</p>
      <button
        type="button"
        className={`tap ${styles.closeBtn}`}
        aria-label={t.dismiss}
        onClick={dismiss}
      >
        <Icon name="close" size={18} strokeWidth={2.4} />
      </button>
    </div>
  );
}
