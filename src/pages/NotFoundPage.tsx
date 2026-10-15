import { Link } from 'react-router';
import { Headline } from '../components/bits';
import { BottomNav } from '../components/controls';
import { parseHeadline } from '../domain/headlines';
import { useT } from '../i18n/context';

export function NotFoundPage() {
  const t = useT();
  return (
    <main
      id="main"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '40px 0' }}
    >
      <Headline
        parts={parseHeadline(t.pageNotFound)}
        style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.025em' }}
      />
      <p className="note" style={{ fontSize: 24 }}>
        {t.pageNotFoundBody}
      </p>
      <Link viewTransition to="/">
        {t.backToList}
      </Link>
      <BottomNav />
    </main>
  );
}
