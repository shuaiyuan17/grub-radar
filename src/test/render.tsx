import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../routes';

/** Renders the real app routes at `path`. */
export function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  return { user, router, ...render(<RouterProvider router={router} />) };
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
