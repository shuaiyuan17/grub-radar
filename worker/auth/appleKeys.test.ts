import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from '../lib/crypto';
import { HOUR, MINUTE } from '../lib/time';
import { CLIENT_ID, fakeAppleKeys, mockApple, tokenResponse } from '../test/helpers';
import {
  appleKeys,
  JWKS_DEFAULT_TTL_MS,
  jwksTtlMs,
  resetAppleKeys,
  verifyWithAppleKeys,
} from './appleKeys';
import { SiwaError } from './siwa';

const NONCE = 'n';
const nonceHash = await sha256Hex(NONCE);
const verify = (token: string, keys: Awaited<ReturnType<typeof appleKeys>>, now?: number) =>
  verifyWithAppleKeys(env, token, { clientId: CLIENT_ID, nonceHash }, keys, undefined, now);

beforeEach(async () => {
  await resetAppleKeys(env);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('jwksTtlMs', () => {
  it.each([
    ['no-store', JWKS_DEFAULT_TTL_MS], // what Apple sends today
    [null, JWKS_DEFAULT_TTL_MS],
    ['public, max-age=3600', HOUR],
    ['max-age=60', 5 * MINUTE], // clamped up
    ['max-age=999999', 24 * HOUR], // clamped down
  ])('%s -> %d ms', (header, ms) => {
    expect(jwksTtlMs(header)).toBe(ms);
  });
});

describe('appleKeys', () => {
  it('asks Apple once, then serves from memory, then from the Cache API in a new isolate', async () => {
    const apple = await fakeAppleKeys();
    const mock = mockApple(apple, () => tokenResponse(''));
    const t0 = Date.now();
    expect((await appleKeys(env, t0)).source).toBe('network');
    expect((await appleKeys(env, t0 + MINUTE)).source).toBe('memory');
    await resetAppleKeys(env, { isolateOnly: true });
    const cached = await appleKeys(env, t0 + 2 * MINUTE);
    expect(cached.source).toBe('cache');
    expect(cached.jwks).toEqual(apple.jwks);
    expect(mock.keyFetches).toHaveLength(1);
  });

  it('honours the lifetime: after it, back to Apple', async () => {
    const apple = await fakeAppleKeys();
    const mock = mockApple(apple, () => tokenResponse(''));
    const t0 = Date.now();
    await appleKeys(env, t0);
    await resetAppleKeys(env, { isolateOnly: true });
    // the Cache API copy carries the same expiry as the memory one
    expect((await appleKeys(env, t0 + JWKS_DEFAULT_TTL_MS - 1)).source).toBe('cache');
    expect((await appleKeys(env, t0 + JWKS_DEFAULT_TTL_MS + 1)).source).toBe('network');
    expect(mock.keyFetches).toHaveLength(2);
  });

  it('a bad answer from Apple is an error, and nothing is cached', async () => {
    const apple = await fakeAppleKeys();
    mockApple(
      apple,
      () => tokenResponse(''),
      () => Response.json({ keys: [] }),
    );
    await expect(appleKeys(env)).rejects.toBeInstanceOf(SiwaError);
    vi.restoreAllMocks();
    const mock = mockApple(apple, () => tokenResponse(''));
    expect((await appleKeys(env)).source).toBe('network');
    expect(mock.keyFetches).toHaveLength(1);
  });
});

describe('verifyWithAppleKeys', () => {
  it('Apple rotated its key: an unknown kid refetches once and verifies', async () => {
    const before = await fakeAppleKeys('kid-old');
    const after = await fakeAppleKeys('kid-new');
    const published = { current: before.jwks };
    const mock = mockApple(
      before,
      () => tokenResponse(''),
      () => Response.json(published.current),
    );
    await appleKeys(env); // cached: the old set
    published.current = { keys: [...before.jwks.keys, ...after.jwks.keys] };
    const keys = await appleKeys(env);
    expect(keys.source).toBe('memory');
    const identity = await verify(await after.idToken({ nonce: NONCE }), keys);
    expect(identity.sub).toBe('000123.fictional-sub.0456');
    expect(mock.keyFetches).toHaveLength(2);
  });

  it('a cached key that no longer matches (same kid, new key) refetches too', async () => {
    const old = await fakeAppleKeys('k');
    const fresh = await fakeAppleKeys('k');
    const published = { current: old.jwks };
    mockApple(
      old,
      () => tokenResponse(''),
      () => Response.json(published.current),
    );
    await appleKeys(env);
    published.current = fresh.jwks;
    const identity = await verify(await fresh.idToken({ nonce: NONCE }), await appleKeys(env));
    expect(identity.sub).toBe('000123.fictional-sub.0456');
  });

  it('unknown kids refetch at most once a minute, and are still refused', async () => {
    const apple = await fakeAppleKeys('real');
    const stranger = await fakeAppleKeys('stranger');
    const mock = mockApple(apple, () => tokenResponse(''));
    const t0 = Date.now();
    await appleKeys(env, t0);
    const keys = await appleKeys(env, t0); // from memory, like any sign-in after the first
    const token = await stranger.idToken({ nonce: NONCE });
    for (const dt of [0, 1000, 30_000]) {
      await expect(verify(token, keys, t0 + dt)).rejects.toMatchObject({ reason: 'id_token' });
    }
    expect(mock.keyFetches).toHaveLength(2); // the first load + one forced refetch
    await expect(verify(token, keys, t0 + 2 * MINUTE)).rejects.toBeInstanceOf(SiwaError);
    expect(mock.keyFetches).toHaveLength(3);
  });

  it('a rotation racing the first fetch: keys fresh from Apple still get one refetch', async () => {
    const before = await fakeAppleKeys('kid-old');
    const after = await fakeAppleKeys('kid-new');
    // Apple hands us the old set, then rotates before the token is checked
    const sets = [before.jwks, { keys: [...before.jwks.keys, ...after.jwks.keys] }];
    const mock = mockApple(
      before,
      () => tokenResponse(''),
      () => Response.json(sets[Math.min(mock.keyFetches.length - 1, 1)]),
    );
    const keys = await appleKeys(env);
    expect(keys.source).toBe('network');
    const identity = await verify(await after.idToken({ nonce: NONCE }), keys);
    expect(identity.sub).toBe('000123.fictional-sub.0456');
    expect(mock.keyFetches).toHaveLength(2);
  });

  it('keys straight from Apple: an unknown kid refetches once (cooldown), then is refused', async () => {
    const apple = await fakeAppleKeys();
    const stranger = await fakeAppleKeys('stranger');
    const mock = mockApple(apple, () => tokenResponse(''));
    const keys = await appleKeys(env);
    expect(keys.source).toBe('network');
    const token = await stranger.idToken({ nonce: NONCE });
    await expect(verify(token, keys)).rejects.toBeInstanceOf(SiwaError);
    await expect(verify(token, keys)).rejects.toBeInstanceOf(SiwaError);
    expect(mock.keyFetches).toHaveLength(2);
  });

  it('a nonce mismatch is never a reason to refetch', async () => {
    const apple = await fakeAppleKeys();
    const mock = mockApple(apple, () => tokenResponse(''));
    await appleKeys(env);
    const keys = await appleKeys(env);
    await expect(verify(await apple.idToken({ nonce: 'other' }), keys)).rejects.toMatchObject({
      reason: 'nonce',
    });
    expect(mock.keyFetches).toHaveLength(1);
  });
});
