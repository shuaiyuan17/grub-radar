import { Link } from 'react-router';
import { BottomNav } from '../components/controls';

export function NotFoundPage() {
  return (
    <main
      id="main"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '40px 0' }}
    >
      <h1 style={{ fontSize: 34, fontWeight: 800, letterSpacing: '-0.025em' }}>
        nothing on the <span className="hl">radar</span> here.
      </h1>
      <p className="note" style={{ fontSize: 24 }}>
        wrong turn. happens to the best of us.
      </p>
      <Link viewTransition to="/">
        back to the list
      </Link>
      <BottomNav />
    </main>
  );
}
