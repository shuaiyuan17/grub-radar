import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AuthProvider } from '../components/AuthProvider';
import type { MeResponse } from '../contracts/me';
import { StaticSpotRepository } from '../data/staticRepository';
import type { SpotRepository } from '../domain/repository';
import type { AuthClient, AuthState } from '../lib/auth';
import { SpotSourceContext } from '../lib/spotSource';
import { routes } from '../routes';

export const TEST_ME: MeResponse = {
  user: { id: 'u_test', displayName: 'Tess Lau', avatarEmoji: '🥟' },
  home: null,
  signupOpen: false,
};

/** An AuthClient that never touches the network; records what was asked of it. */
export function fakeAuthClient(me: MeResponse | null = TEST_ME) {
  const client = {
    me: vi.fn(() => Promise.resolve(me)),
    signOut: vi.fn(() => Promise.resolve()),
    signInUrl: vi.fn(
      (returnTo: string) => `/auth/apple/start?returnTo=${encodeURIComponent(returnTo)}`,
    ),
  } satisfies AuthClient;
  return client;
}

/**
 * Renders the real app routes at `path`, signed in by default, with the
 * demo spots as the data source.
 */
export function renderAt(
  path: string,
  opts: { auth?: AuthState; client?: AuthClient; repository?: SpotRepository } = {},
) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const client = opts.client ?? fakeAuthClient();
  const auth = 'auth' in opts ? opts.auth : { status: 'signed-in' as const, me: TEST_ME };
  return {
    user,
    router,
    client,
    ...render(
      <AuthProvider client={client} initial={auth}>
        <SpotSourceContext value={opts.repository ?? new StaticSpotRepository()}>
          <RouterProvider router={router} />
        </SpotSourceContext>
      </AuthProvider>,
    ),
  };
}

type Success = (pos: GeolocationPosition) => void;
type Failure = (err: GeolocationPositionError) => void;

/** Installs a fake navigator.geolocation; returns handles to resolve it. */
export function fakeGeolocation() {
  let ok: Success | undefined;
  let fail: Failure | undefined;
  const getCurrentPosition = vi.fn((s: Success, e: Failure) => {
    ok = s;
    fail = e;
  });
  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition },
  });
  return {
    getCurrentPosition,
    succeed(lat: number, lng: number) {
      ok?.({ coords: { latitude: lat, longitude: lng } } as GeolocationPosition);
    },
    deny() {
      fail?.({ code: 1, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    },
    timeout() {
      fail?.({ code: 3, PERMISSION_DENIED: 1 } as GeolocationPositionError);
    },
  };
}
