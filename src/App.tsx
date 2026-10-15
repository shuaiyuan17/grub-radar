import { useMemo } from 'react';
import { createBrowserRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { AuthProvider } from './components/AuthProvider';
import { HttpSpotRepository } from './data/httpRepository';
import { useAuth } from './lib/auth';
import { SpotSourceContext } from './lib/spotSource';
import { routes } from './routes';

const router = createBrowserRouter(routes);

/** Spots come from the API; a 401 there (session gone) brings the wall back. */
function Wired() {
  const { markSignedOut } = useAuth();
  const repository = useMemo(() => new HttpSpotRepository(markSignedOut), [markSignedOut]);
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
