import { createContext, use } from 'react';
import { MeResponseSchema, type MeResponse } from '../contracts/me';
import { api, isUnauthorized } from './api';

export type AuthState =
  { status: 'loading' } | { status: 'signed-out' } | { status: 'signed-in'; me: MeResponse };

export interface AuthValue {
  state: AuthState;
  /** Off to Apple, coming back to `returnTo` (defaults to the current page). */
  signIn: (returnTo?: string) => void;
  signOut: () => Promise<void>;
  /** The server said 401 somewhere: show the wall. */
  markSignedOut: () => void;
  /** Home was saved or cleared on the server: keep `me.home` in step. */
  setMeHome: (home: MeResponse['home']) => void;
  /** Your name or emoji changed on the server (PATCH /api/me): show it everywhere. */
  setMeUser: (user: MeResponse['user']) => void;
}

export const AuthContext = createContext<AuthValue | null>(null);

export function useAuth(): AuthValue {
  const ctx = use(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** How the app talks to the auth endpoints; swapped out in tests. */
export interface AuthClient {
  /** null when not signed in. */
  me: () => Promise<MeResponse | null>;
  signOut: () => Promise<void>;
  signInUrl: (returnTo: string) => string;
}

export const httpAuthClient: AuthClient = {
  me: async () => {
    try {
      return MeResponseSchema.parse(await (await api('/api/me')).json());
    } catch (e) {
      if (isUnauthorized(e)) return null;
      throw e;
    }
  },
  signOut: async () => {
    await api('/auth/logout', { method: 'POST' });
  },
  signInUrl: (returnTo) => `/auth/apple/start?returnTo=${encodeURIComponent(returnTo)}`,
};

/** First name only, for the header. */
export const firstName = (displayName: string) => displayName.trim().split(/\s+/)[0] ?? displayName;
