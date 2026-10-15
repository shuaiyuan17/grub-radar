import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AuthContext,
  httpAuthClient,
  type AuthClient,
  type AuthState,
  type AuthValue,
} from '../lib/auth';

/**
 * Asks the Worker who this is (GET /api/me) once per page load and hands the
 * answer to the tree. `initial` skips the request (tests, or a future SSR).
 */
export function AuthProvider({
  children,
  client = httpAuthClient,
  initial,
}: {
  children: ReactNode;
  client?: AuthClient;
  initial?: AuthState;
}) {
  const [state, setState] = useState<AuthState>(initial ?? { status: 'loading' });

  useEffect(() => {
    if (initial) return;
    let live = true;
    client.me().then(
      (me) => {
        if (live) setState(me ? { status: 'signed-in', me } : { status: 'signed-out' });
      },
      () => {
        // network trouble: treat as signed out; the wall has a sign-in button
        if (live) setState({ status: 'signed-out' });
      },
    );
    return () => {
      live = false;
    };
  }, [client, initial]);

  const signIn = useCallback(
    (returnTo?: string) => {
      const here = returnTo ?? `${window.location.pathname}${window.location.search}`;
      window.location.assign(client.signInUrl(here));
    },
    [client],
  );

  const signOut = useCallback(async () => {
    try {
      await client.signOut();
    } finally {
      setState({ status: 'signed-out' });
    }
  }, [client]);

  const markSignedOut = useCallback(() => {
    setState({ status: 'signed-out' });
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ state, signIn, signOut, markSignedOut }),
    [state, signIn, signOut, markSignedOut],
  );
  return <AuthContext value={value}>{children}</AuthContext>;
}
