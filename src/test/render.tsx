import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { AuthProvider } from '../components/AuthProvider';
import type { MeResponse } from '../contracts/me';
import type { ApplePlace } from '../contracts/places';
import { MemorySpotRepository } from '../data/memoryRepository';
import { SEED_SPOTS } from '../data/seed';
import type { LatLng } from '../domain/geo';
import type { SpotRepository } from '../domain/repository';
import type { AuthClient, AuthState } from '../lib/auth';
import { HomeClientContext, type HomeClient } from '../lib/homeClient';
import { PlaceSearchClientContext, type PlaceSearchClient } from '../lib/placeSearch';
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

/** A HomeClient that never touches the network. `fail` makes every call reject. */
export function fakeHomeClient({ fail = false }: { fail?: boolean } = {}) {
  const answer = () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve());
  return {
    save: vi.fn<(home: LatLng) => Promise<void>>(answer),
    clear: vi.fn<() => Promise<void>>(answer),
  } satisfies HomeClient;
}

/** A PlaceSearchClient answering from `places` (names matched on the query); records calls. */
export function fakePlaceSearch(places: readonly ApplePlace[] = []) {
  return {
    search: vi.fn<PlaceSearchClient['search']>((q) =>
      Promise.resolve(places.filter((p) => p.name.toLowerCase().includes(q.q.toLowerCase()))),
    ),
  } satisfies PlaceSearchClient;
}

/** The demo spots, writable in memory (same domain edits as the Worker). */
export const demoRepository = () =>
  new MemorySpotRepository(SEED_SPOTS, { today: () => '2026-10-14' });

/**
 * Renders the real app routes at `path`, signed in by default (with `home`
 * on the account, if given), with the demo spots as a writable in-memory list.
 */
export function renderAt(
  path: string,
  opts: {
    auth?: AuthState;
    client?: AuthClient;
    repository?: SpotRepository;
    homeClient?: HomeClient;
    home?: LatLng | null;
    placeSearch?: PlaceSearchClient;
  } = {},
) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const client = opts.client ?? fakeAuthClient();
  const homeClient = opts.homeClient ?? fakeHomeClient();
  const repository = opts.repository ?? demoRepository();
  const auth =
    'auth' in opts
      ? opts.auth
      : { status: 'signed-in' as const, me: { ...TEST_ME, home: opts.home ?? null } };
  return {
    user,
    router,
    client,
    homeClient,
    repository,
    ...render(
      <AuthProvider client={client} initial={auth}>
        <HomeClientContext value={homeClient}>
          <PlaceSearchClientContext value={opts.placeSearch ?? fakePlaceSearch()}>
            <SpotSourceContext value={repository}>
              <RouterProvider router={router} />
            </SpotSourceContext>
          </PlaceSearchClientContext>
        </HomeClientContext>
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
