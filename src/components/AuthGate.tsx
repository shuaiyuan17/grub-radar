import { Outlet } from 'react-router';
import { useT } from '../i18n/context';
import { I18nProvider } from '../i18n/I18nProvider';
import { useAuth } from '../lib/auth';
import { SignInPage } from '../pages/SignInPage';

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
    return (
      <p className="note" style={{ fontSize: 22, padding: 24 }} aria-busy="true">
        {t.checkingWho}
      </p>
    );
  }
  if (state.status === 'signed-out') return <SignInPage />;
  return <Outlet />;
}
