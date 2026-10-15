import { act, renderHook, waitFor } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { HttpSpotRepository } from '../data/httpRepository';
import type { LatLng } from '../domain/geo';
import {
  forgetPlaceAnswers,
  httpPlaceSearchClient,
  nearParam,
  PlaceSearchClientContext,
  usePlaceSearch,
  type PlaceSearchClient,
} from './placeSearch';

const respond = (status: number, body: unknown) =>
  vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(() =>
    Promise.resolve(new Response(JSON.stringify(body), { status })),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

const PLACE = {
  applePlaceId: 'IF0000000000000A1',
  name: 'Night Owl Pho',
  location: { lat: 47.6152, lng: -122.3201 },
  category: 'Restaurant',
  kind: 'food',
};

describe('httpPlaceSearchClient', () => {
  it('POSTs the search: where you are goes in the body (2 decimals), never in the URL', async () => {
    const fetch = respond(200, { places: [PLACE] });
    vi.stubGlobal('fetch', fetch);
    const ctrl = new AbortController();
    const places = await httpPlaceSearchClient.search(
      { q: ' Night  Owl ', near: { lat: 47.618421, lng: -122.321937 }, lang: 'zh-Hans' },
      ctrl.signal,
    );
    expect(places).toEqual([PLACE]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/places/search');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-Grub-Request': '1' });
    expect(JSON.parse(init?.body as string)).toEqual({
      q: 'night owl',
      lang: 'zh-Hans',
      near: { lat: 47.62, lng: -122.32 },
    });
    expect(init?.signal).toBe(ctrl.signal);
  });

  it('near "home" stays a word: the server knows where that is', async () => {
    const fetch = respond(200, { places: [] });
    vi.stubGlobal('fetch', fetch);
    await httpPlaceSearchClient.search({ q: 'pho', near: 'home', lang: 'en' });
    expect(JSON.parse(fetch.mock.calls[0]?.[1]?.body as string)).toMatchObject({ near: 'home' });
  });

  it('rejects an answer that is not the contract', async () => {
    vi.stubGlobal('fetch', respond(200, { places: [{ name: 'x' }] }));
    await expect(httpPlaceSearchClient.search({ q: 'pho', lang: 'en' })).rejects.toThrow();
  });

  it('nearParam', () => {
    expect(nearParam(undefined)).toBeUndefined();
    expect(nearParam('home')).toBe('home');
    expect(nearParam({ lat: -33.86785, lng: 151.20732 })).toBe('-33.87,151.21');
  });
});

describe('HttpSpotRepository.addApplePlace', () => {
  it('POSTs the Apple id (with the CSRF header) and returns the spot', async () => {
    const spot = {
      id: 'p-01',
      name: 'Night Owl Pho',
      kind: 'food',
      price: '$$',
      tags: [],
      status: 'want',
      order: [],
      icon: 'bowl',
      location: PLACE.location,
      applePlaceId: PLACE.applePlaceId,
      address: '101 Lantern St',
      version: 1,
    };
    const fetch = respond(201, spot);
    vi.stubGlobal('fetch', fetch);
    const saved = await new HttpSpotRepository().addApplePlace({
      applePlaceId: PLACE.applePlaceId,
      kind: 'food',
    });
    expect(saved).toMatchObject({ applePlaceId: PLACE.applePlaceId, address: '101 Lantern St' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/spots');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-Grub-Request': '1' });
    expect(JSON.parse(init?.body as string)).toEqual({
      applePlaceId: PLACE.applePlaceId,
      kind: 'food',
    });
  });
});

describe('usePlaceSearch remembers answers per place searched around', () => {
  it('moving home (near is still "home") searches again instead of reusing the old answer', async () => {
    forgetPlaceAnswers();
    const client = {
      search: vi.fn<PlaceSearchClient['search']>(() => Promise.resolve([])),
    } satisfies PlaceSearchClient;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(PlaceSearchClientContext, { value: client }, children);
    const OLD_HOME = { lat: 47.618421, lng: -122.321937 };
    const NEW_HOME = { lat: 47.66, lng: -122.38 };
    const { result, rerender } = renderHook(
      ({ centre }: { centre: LatLng }) => usePlaceSearch('pho', 'home', 'en', centre),
      { wrapper, initialProps: { centre: OLD_HOME } },
    );
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(client.search).toHaveBeenCalledTimes(1);

    rerender({ centre: NEW_HOME });
    // not the old home's answer
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(2);
    });

    // back to the old home (within the same ~1 km): remembered, no new request
    rerender({ centre: { lat: 47.6184, lng: -122.3219 } });
    expect(result.current.state.status).toBe('ready');
    await act(() => new Promise((r) => setTimeout(r, 400)));
    expect(client.search).toHaveBeenCalledTimes(2);
  });
});

describe('usePlaceSearch: Enter retries', () => {
  it('after an error, each Enter asks again (not just the first)', async () => {
    forgetPlaceAnswers();
    let fails = 2;
    const client = {
      search: vi.fn<PlaceSearchClient['search']>(() =>
        fails-- > 0 ? Promise.reject(new Error('offline')) : Promise.resolve([]),
      ),
    } satisfies PlaceSearchClient;
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(PlaceSearchClientContext, { value: client }, children);
    const here = { lat: 47.61, lng: -122.33 };
    const { result } = renderHook(() => usePlaceSearch('pho', here, 'en', here), { wrapper });
    await waitFor(() => {
      expect(result.current.state.status).toBe('error');
    });
    act(() => {
      result.current.now();
    });
    expect(result.current.state.status).toBe('loading');
    await waitFor(() => {
      expect(client.search).toHaveBeenCalledTimes(2);
      expect(result.current.state.status).toBe('error');
    });
    act(() => {
      result.current.now();
    });
    await waitFor(() => {
      expect(result.current.state.status).toBe('ready');
    });
    expect(client.search).toHaveBeenCalledTimes(3);
  });
});
