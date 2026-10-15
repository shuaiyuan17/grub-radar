import {
  Link,
  Outlet,
  ScrollRestoration,
  useLocation,
  useNavigate,
  useSearchParams,
} from 'react-router';
import { AccountMenu } from '../components/AccountMenu';
import { Logo } from '../components/bits';
import { FromToggle, LangToggle, OriginNotice, SearchBox } from '../components/controls';
import { HomeConsent, HomeEditor } from '../components/HomeControls';
import { Icon } from '../components/Icon';
import { Ink } from '../components/Ink';
import { OriginProvider } from '../components/OriginProvider';
import { SpotsProvider } from '../components/SpotsProvider';
import { useT } from '../i18n/context';
import { useAuth } from '../lib/auth';
import { useHomeClient } from '../lib/homeClient';
import { useSpotSource } from '../lib/spotSource';
import styles from './Layout.module.css';

/** Desktop header search drives the list's ?q= param from any page. */
function HeaderSearch() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const onList = location.pathname === '/';
  const value = onList ? (params.get('q') ?? '') : '';
  return (
    <SearchBox
      id="search-desktop"
      className={styles.search}
      value={value}
      onChange={(q) => {
        const next = new URLSearchParams(onList ? params : undefined);
        next.delete('roll');
        if (q) next.set('q', q);
        else next.delete('q');
        const search = next.toString();
        void navigate({ pathname: '/', search: search ? `?${search}` : '' }, { replace: onList });
      }}
    />
  );
}

/** The signed-in app shell. I18nProvider sits above it, in AuthGate. */
export function Layout() {
  const t = useT();
  const repository = useSpotSource();
  const homeClient = useHomeClient();
  const { state, setMeHome } = useAuth();
  // AuthGate only renders this signed in
  const initialHome = state.status === 'signed-in' ? state.me.home : null;
  return (
    <OriginProvider initialHome={initialHome} client={homeClient} onSaved={setMeHome}>
      <a className={styles.skip} href="#main">
        {t.skip}
      </a>
      <div className={styles.shell}>
        {/* phones: the language switch gets its own slim row at the very top */}
        <div className={`phone-only ${styles.langRow}`}>
          <LangToggle />
        </div>
        <header className={`desktop-only ${styles.header}`}>
          <div className={styles.brand}>
            <Logo />
          </div>
          <HeaderSearch />
          <FromToggle compact />
          <Link viewTransition to="/add" className={`sk press ${styles.add}`}>
            <Ink />
            <Icon name="plus" size={18} strokeWidth={2.6} />
            {t.addSpot}
          </Link>
          <LangToggle />
          <AccountMenu />
        </header>
        <OriginNotice />
        <HomeConsent />
        <HomeEditor />
        <SpotsProvider repository={repository}>
          <Outlet />
        </SpotsProvider>
      </div>
      <ScrollRestoration />
    </OriginProvider>
  );
}
