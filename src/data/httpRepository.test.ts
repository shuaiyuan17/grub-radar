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

describe('HttpSpotRepository writes', () => {
  const spot = SEED_SPOTS[0];
  const calls = () => {
    const fetch = respond(200, spot);
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof calls>) => {
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    return {
      url,
      method: init.method,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined,
      headers: init.headers as Record<string, string>,
    };
  };

  it.each([
    [
      'add',
      (r: HttpSpotRepository) => r.add({ name: 'x', kind: 'food', location: { lat: 1, lng: 2 } }),
      'POST',
      '/api/spots',
    ],
    [
      'update',
      (r: HttpSpotRepository) => r.update('a b', { note: 'n' }),
      'PATCH',
      '/api/spots/a%20b',
    ],
    [
      'markBeen',
      (r: HttpSpotRepository) => r.markBeen('x', { rating: 9 }),
      'POST',
      '/api/spots/x/been',
    ],
    [
      'addNote',
      (r: HttpSpotRepository) => r.addNote('x', { note: 'n' }),
      'POST',
      '/api/spots/x/notes',
    ],
  ])('%s -> %s %s, JSON with the CSRF header, answer validated', async (_name, op, method, url) => {
    const fetch = calls();
    expect((await op(new HttpSpotRepository())).id).toBe(spot!.id);
    const req = sent(fetch);
    expect(req).toMatchObject({ url, method });
    expect(req.headers).toMatchObject({
      'content-type': 'application/json',
      'X-Grub-Request': '1',
    });
  });

  it('remove -> DELETE; errors carry the server code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(null, { status: 204 }))),
    );
    await new HttpSpotRepository().remove('x');
    vi.stubGlobal(
      'fetch',
      respond(400, { error: { code: 'note_too_long', message: 'notes are capped' } }),
    );
    await expect(new HttpSpotRepository().addNote('x', { note: 'n' })).rejects.toMatchObject({
      code: 'note_too_long',
      status: 400,
    });
  });

  it('a 401 on a write also brings the wall back', async () => {
    vi.stubGlobal('fetch', respond(401, { error: { code: 'unauthorized', message: 'sign in' } }));
    const onUnauthorized = vi.fn();
    await expect(
      new HttpSpotRepository(onUnauthorized).update('x', { note: 'n' }),
    ).rejects.toThrow();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });
});
