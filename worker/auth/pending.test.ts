import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { MINUTE, SECOND } from '../lib/time';
import { openPending, PENDING_MAX_AGE_S, sealPending } from './pending';
import type { StatePayload } from './siwa';

const T0 = Date.UTC(2026, 9, 15, 12, 0);
const state: StatePayload = {
  state: 's',
  nonceHash: 'nh',
  returnTo: '/radar',
  iat: T0,
  prevSession: 'prev',
};

describe('pending sign-in hand-off', () => {
  it('round-trips what /auth/finish needs, for the matching t only', async () => {
    const { cookie, finish } = await sealPending(
      env,
      state,
      { code: 'c1', user: '{"name":{}}' },
      T0,
    );
    expect(await openPending(env, cookie, finish, T0 + SECOND)).toEqual({
      code: 'c1',
      user: '{"name":{}}',
      nonceHash: 'nh',
      returnTo: '/radar',
      prevSession: 'prev',
      iat: T0,
      finish,
    });
    expect(await openPending(env, cookie, `${finish}x`, T0)).toBeNull();
    expect(await openPending(env, cookie, undefined, T0)).toBeNull();
    expect(await openPending(env, undefined, finish, T0)).toBeNull();
  });

  it('lasts two minutes', async () => {
    const { cookie, finish } = await sealPending(env, state, { code: 'c', user: undefined }, T0);
    expect(await openPending(env, cookie, finish, T0 + PENDING_MAX_AGE_S * SECOND)).not.toBeNull();
    expect(await openPending(env, cookie, finish, T0 + PENDING_MAX_AGE_S * SECOND + 1)).toBeNull();
    expect(await openPending(env, cookie, finish, T0 - 2 * MINUTE)).toBeNull();
  });

  it('is sealed with the server key: another key, or any edit, opens nothing', async () => {
    const { cookie, finish } = await sealPending(env, state, { code: 'c', user: undefined }, T0);
    const other: Env = { ...env, SESSION_HMAC_KEY: 'another-key-another-key-another-k' };
    expect(await openPending(other, cookie, finish, T0)).toBeNull();
    const [iv = '', ct = ''] = cookie.split('.');
    const edited = `${iv}.${ct.slice(0, 10)}${ct[10] === 'A' ? 'B' : 'A'}${ct.slice(11)}`;
    expect(await openPending(env, edited, finish, T0)).toBeNull();
    expect(await openPending(env, 'garbage', finish, T0)).toBeNull();
  });

  it('drops an oversized `user` field rather than carrying it', async () => {
    const { cookie, finish } = await sealPending(
      env,
      state,
      { code: 'c', user: 'x'.repeat(5000) },
      T0,
    );
    expect((await openPending(env, cookie, finish, T0))?.user).toBeUndefined();
  });
});
