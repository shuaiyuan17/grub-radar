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
import type { FriendTake } from '../contracts/friends';
import { FriendsClientContext, type FriendsClient } from '../lib/friends';
import { PhotosClientContext, type PhotosClient } from '../lib/photos';
import type { Photo, PlacePhotosResponse } from '../contracts/photos';
import { HomeClientContext, type HomeClient } from '../lib/homeClient';
import { PlaceSearchClientContext, type PlaceSearchClient } from '../lib/placeSearch';
import { SpotSourceContext } from '../lib/spotSource';
import { routes } from '../routes';

export const TEST_ME: MeResponse = {
  user: { id: 'u_test', displayName: 'Tess Lau', avatarEmoji: '🥟', nameSet: true },
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

/**
 * A FriendsClient that never touches the network: `takes` answers
 * GET /api/friends/places; everything else is a spy you can re-stub.
 */
export function fakeFriendsClient(takes: Record<string, FriendTake[]> = {}) {
  return {
    places: vi.fn<FriendsClient['places']>(() => Promise.resolve(takes)),
    list: vi.fn<FriendsClient['list']>(() => Promise.resolve({ friends: [], limit: 200 })),
    invites: vi.fn<FriendsClient['invites']>(() => Promise.resolve([])),
    createInvite: vi.fn<FriendsClient['createInvite']>(() =>
      Promise.resolve({
        id: 'inv_1',
        token: 'T'.repeat(43),
        path: `/invite#${'T'.repeat(43)}`,
        createdAt: '2026-10-15T12:00:00.000Z',
        expiresAt: '2026-10-22T12:00:00.000Z',
      }),
    ),
    revokeInvite: vi.fn<FriendsClient['revokeInvite']>(() => Promise.resolve()),
    unfriend: vi.fn<FriendsClient['unfriend']>(() => Promise.resolve()),
    friendSpots: vi.fn<FriendsClient['friendSpots']>(() => Promise.reject(new Error('unset'))),
    preview: vi.fn<FriendsClient['preview']>(() => Promise.reject(new Error('unset'))),
    accept: vi.fn<FriendsClient['accept']>(() => Promise.reject(new Error('unset'))),
    updateProfile: vi.fn<FriendsClient['updateProfile']>((patch) =>
      Promise.resolve({ ...TEST_ME.user, ...patch }),
    ),
  } satisfies FriendsClient;
}

/**
 * A PhotosClient that never touches the network (nor a canvas): `byPlace`
 * answers GET /api/photos; prepare is a pass-through, upload reports 50% then
 * 100% and stores; everything is a spy you can re-stub.
 */
export function fakePhotosClient(byPlace: Record<string, Partial<PlacePhotosResponse>> = {}) {
  const usage = { bytes: 0, maxBytes: 200 * 1024 * 1024, perSpot: 6 };
  let n = 0;
  return {
    forPlace: vi.fn<PhotosClient['forPlace']>((placeId) =>
      Promise.resolve({ mine: [], friends: {}, usage, ...byPlace[placeId] }),
    ),
    prepare: vi.fn<PhotosClient['prepare']>((file) =>
      Promise.resolve({ blob: file, type: 'image/webp', width: 1600, height: 1200 }),
    ),
    upload: vi.fn<PhotosClient['upload']>((_place, prepared, onProgress) => {
      onProgress(0.5);
      onProgress(1);
      n += 1;
      const photo: Photo = {
        id: `ph_${String(n).padStart(26, '0')}`,
        width: prepared.width,
        height: prepared.height,
        bytes: prepared.blob.size,
        createdAt: '2026-10-15T12:00:00.000Z',
        url: `/api/photos/ph_${String(n).padStart(26, '0')}`,
      };
      return Promise.resolve(photo);
    }),
    remove: vi.fn<PhotosClient['remove']>(() => Promise.resolve()),
    caption: vi.fn<PhotosClient['caption']>((id, caption) =>
      Promise.resolve({
        id,
        width: 1600,
        height: 1200,
        bytes: 1000,
        createdAt: '2026-10-15T12:00:00.000Z',
        url: `/api/photos/${id}`,
        ...(caption ? { caption } : {}),
      }),
    ),
  } satisfies PhotosClient;
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
    friends?: FriendsClient;
    photos?: PhotosClient;
  } = {},
) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const client = opts.client ?? fakeAuthClient();
  const homeClient = opts.homeClient ?? fakeHomeClient();
  const repository = opts.repository ?? demoRepository();
  const friends = opts.friends ?? fakeFriendsClient();
  const photos = opts.photos ?? fakePhotosClient();
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
    friends,
    photos,
    ...render(
      <AuthProvider client={client} initial={auth}>
        <HomeClientContext value={homeClient}>
          <PlaceSearchClientContext value={opts.placeSearch ?? fakePlaceSearch()}>
            <SpotSourceContext value={repository}>
              <FriendsClientContext value={friends}>
                <PhotosClientContext value={photos}>
                  <RouterProvider router={router} />
                </PhotosClientContext>
              </FriendsClientContext>
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
