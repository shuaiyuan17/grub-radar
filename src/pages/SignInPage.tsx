import type { ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router';
import { AppleSignInButton } from '../components/AppleSignInButton';
import { Headline, Logo } from '../components/bits';
import { Icon } from '../components/Icon';
import { Ink } from '../components/Ink';
import { SIGNIN_RESULTS, type SigninResult } from '../contracts/errors';
import { LangToggle } from '../components/controls';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';
import { useAuth } from '../lib/auth';
import styles from './SignInPage.module.css';

const isSigninResult = (v: string | null): v is SigninResult =>
  (SIGNIN_RESULTS as readonly (string | null)[]).includes(v);

/** Decorative radar rings. No data: the wall shows nothing until you sign in. */
function RingsBackdrop() {
  return (
    <svg className={styles.rings} viewBox="-100 -100 200 200" preserveAspectRatio="xMidYMid slice">
      {[22, 46, 72, 98].map((r, i) => (
        <circle
          key={r}
          r={r}
          fill="none"
          stroke="var(--rule)"
          strokeWidth={0.6}
          strokeDasharray={i === 3 ? '2 3' : undefined}
        />
      ))}
      <path d="M0 0 L69 -69" stroke="var(--rule)" strokeWidth={0.6} strokeLinecap="round" />
    </svg>
  );
}

/**
 * The login wall: what anyone without a session sees, on every URL.
 *
 * Laid out as a landing with two layers: `backdrop` fills the screen behind
 * a card. Today the backdrop is decorative rings; the next step puts a MapKit
 * JS map of nearby Apple POIs there (token from GET /api/mapkit-token) with
 * this same card on top.
 */
export function SignInPage({ backdrop }: { backdrop?: ReactNode }) {
  const t = useT();
  const { signIn } = useAuth();
  const [params, setParams] = useSearchParams();
  const { pathname } = useLocation();
  const result = params.get('signin');

  const dismiss = () => {
    const next = new URLSearchParams(params);
    next.delete('signin');
    setParams(next, { replace: true });
  };

  return (
    <div className={styles.landing}>
      <div className={styles.backdrop} aria-hidden="true">
        {backdrop ?? <RingsBackdrop />}
      </div>
      <div className={styles.langRow}>
        <LangToggle />
      </div>
      <main id="main" className={styles.stage}>
        <section className={`sk ${styles.card}`} aria-labelledby="wall-title">
          <Ink />
          <div className={styles.logo}>
            <Logo />
          </div>
          <Headline
            id="wall-title"
            className={styles.tagline}
            parts={parseHeadline(t.wallTagline)}
          />
          <div role="status" className={styles.status}>
            {isSigninResult(result) && (
              <div className={`sk ${styles.notice}`}>
                <Ink />
                <p>{t.signinResult[result]}</p>
                <button
                  type="button"
                  className={`tap ${styles.closeBtn}`}
                  aria-label={t.dismiss}
                  onClick={dismiss}
                >
                  <Icon name="close" size={18} strokeWidth={2.4} />
                </button>
              </div>
            )}
          </div>
          <AppleSignInButton
            onClick={() => {
              // come back to the page they asked for, minus the old result
              const next = new URLSearchParams(params);
              next.delete('signin');
              const q = next.toString();
              signIn(`${pathname}${q ? `?${q}` : ''}`);
            }}
          />
        </section>
      </main>
    </div>
  );
}
