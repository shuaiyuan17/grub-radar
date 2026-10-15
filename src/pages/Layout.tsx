import { Outlet, ScrollRestoration, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Logo } from '../components/bits';
import { FromToggle, OriginNotice, SearchBox } from '../components/controls';
import { HomeEditor } from '../components/HomeControls';
import { OriginProvider } from '../components/OriginProvider';
import { SpotsProvider } from '../components/SpotsProvider';
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

export function Layout() {
  return (
    <OriginProvider>
      <a className={styles.skip} href="#main">
        skip to content
      </a>
      <div className={styles.shell}>
        <header className={`desktop-only ${styles.header}`}>
          <div className={styles.brand}>
            <Logo />
          </div>
          <HeaderSearch />
          <FromToggle compact />
        </header>
        <OriginNotice />
        <HomeEditor />
        <SpotsProvider>
          <Outlet />
        </SpotsProvider>
      </div>
      <ScrollRestoration />
    </OriginProvider>
  );
}
