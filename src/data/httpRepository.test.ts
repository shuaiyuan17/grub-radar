import { SEED_SPOTS } from './seed';
import { HttpSpotRepository } from './httpRepository';

const respond = (status: number, body: unknown) =>
  vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpSpotRepository', () => {
  it('lists spots from /api/spots, validated', async () => {
    const fetch = respond(200, SEED_SPOTS);
    vi.stubGlobal('fetch', fetch);
    const spots = await new HttpSpotRepository().list();
    expect(spots).toHaveLength(SEED_SPOTS.length);
    expect(fetch).toHaveBeenCalledWith(
      '/api/spots',
      expect.objectContaining({ method: 'GET', credentials: 'same-origin' }),
    );
  });

  it('rejects data that fails the schema', async () => {
    vi.stubGlobal('fetch', respond(200, [{ id: 'x' }]));
    await expect(new HttpSpotRepository().list()).rejects.toThrow();
  });

  it('a 401 means the session is gone: tell the app, then fail', async () => {
    vi.stubGlobal(
      'fetch',
      respond(401, { error: { code: 'unauthorized', message: 'sign in first' } }),
    );
    const onUnauthorized = vi.fn();
    await expect(new HttpSpotRepository(onUnauthorized).list()).rejects.toThrow('sign in first');
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('get: one spot, or null on 404', async () => {
    vi.stubGlobal('fetch', respond(200, SEED_SPOTS[0]));
    expect((await new HttpSpotRepository().get('lucky-thread'))?.id).toBe('lucky-thread');
    vi.stubGlobal('fetch', respond(404, { error: { code: 'not_found', message: 'no such spot' } }));
    expect(await new HttpSpotRepository().get('nope')).toBeNull();
  });
});
