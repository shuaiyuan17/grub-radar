import { api, ApiRequestError } from './api';
import { httpAuthClient } from './auth';

const ok = (body: unknown = {}, status = 200) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api()', () => {
  it('reads plainly', async () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    await api('/api/me');
    const init = fetch.mock.calls[0]?.[1] ?? {};
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(init.body).toBeUndefined();
  });

  it('writes with JSON and the CSRF header the Worker requires', async () => {
    const fetch = ok();
    vi.stubGlobal('fetch', fetch);
    await api('/auth/logout', { method: 'POST' });
    const init = fetch.mock.calls[0]?.[1] ?? {};
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'X-Grub-Request': '1',
    });
    expect(init.body).toBe('{}');
  });

  it('turns error bodies into ApiRequestError', async () => {
    vi.stubGlobal('fetch', ok({ error: { code: 'csrf', message: 'nope' } }, 403));
    await expect(api('/x', { method: 'POST' })).rejects.toEqual(
      new ApiRequestError(403, 'csrf', 'nope'),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('<html>', { status: 502 }))),
    );
    await expect(api('/x')).rejects.toMatchObject({ status: 502, code: 'http' });
  });
});

describe('httpAuthClient', () => {
  it('me(): the parsed user, or null on 401', async () => {
    const me = {
      user: { id: 'u_1', displayName: 'Tess', avatarEmoji: '🍜' },
      home: null,
      signupOpen: false,
    };
    vi.stubGlobal('fetch', ok(me));
    expect(await httpAuthClient.me()).toEqual(me);
    vi.stubGlobal('fetch', ok({ error: { code: 'unauthorized', message: 'sign in first' } }, 401));
    expect(await httpAuthClient.me()).toBeNull();
    vi.stubGlobal('fetch', ok({}, 500));
    await expect(httpAuthClient.me()).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('signInUrl() encodes where to come back to', () => {
    expect(httpAuthClient.signInUrl('/place/x?y=1')).toBe(
      '/auth/apple/start?returnTo=%2Fplace%2Fx%3Fy%3D1',
    );
  });
});
