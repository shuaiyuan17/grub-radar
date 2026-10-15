import { HttpSpotRepository } from '../data/httpRepository';
import { httpPlaceSearchClient, nearParam } from './placeSearch';

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
  it('GETs /api/places/search with the query, a rounded centre and the language', async () => {
    const fetch = respond(200, { places: [PLACE] });
    vi.stubGlobal('fetch', fetch);
    const ctrl = new AbortController();
    const places = await httpPlaceSearchClient.search(
      { q: ' Night  Owl ', near: { lat: 47.618421, lng: -122.321937 }, lang: 'zh-Hans' },
      ctrl.signal,
    );
    expect(places).toEqual([PLACE]);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/places/search?q=night+owl&lang=zh-Hans&near=47.62%2C-122.32');
    expect(init?.signal).toBe(ctrl.signal);
  });

  it('near=home stays a word: the server knows where that is', async () => {
    const fetch = respond(200, { places: [] });
    vi.stubGlobal('fetch', fetch);
    await httpPlaceSearchClient.search({ q: 'pho', near: 'home', lang: 'en' });
    expect(fetch.mock.calls[0]?.[0]).toContain('near=home');
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
      lang: 'en',
    });
    expect(saved).toMatchObject({ applePlaceId: PLACE.applePlaceId, address: '101 Lantern St' });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/api/spots');
    expect(init?.method).toBe('POST');
    expect(init?.headers).toMatchObject({ 'X-Grub-Request': '1' });
    expect(JSON.parse(init?.body as string)).toEqual({
      applePlaceId: PLACE.applePlaceId,
      kind: 'food',
      lang: 'en',
    });
  });
});
