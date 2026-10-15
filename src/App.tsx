import { useEffect, useMemo } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from './components/AuthProvider';
import { HttpSpotRepository } from './data/httpRepository';
import { useAuth } from './lib/auth';
import { SpotSourceContext } from './lib/spotSource';
import { routes } from './routes';

const router = createBrowserRouter(routes);

/**
 * Spots come from the API; a 401 there (session gone) brings the wall back.
 * The list is asked for at once, in parallel with "who am I" (GET /api/me),
 * not after it: page load is one wait, not two.
 */
function Wired() {
  const { markSignedOut } = useAuth();
  const repository = useMemo(() => new HttpSpotRepository(markSignedOut), [markSignedOut]);
  useEffect(() => {
    repository.prime();
  }, [repository]);
  return (
    <SpotSourceContext value={repository}>
      <RouterProvider router={router} />
    </SpotSourceContext>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Wired />
    </AuthProvider>
  );
}
