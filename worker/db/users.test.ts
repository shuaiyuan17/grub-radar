import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AppleIdentity } from '../auth/siwa';
import type { Env } from '../env';
import { admission, signInWithApple, signupOpen } from './users';

const who = (sub: string): AppleIdentity => ({ sub, email: null, emailIsRelay: false });
const opts = { displayName: null, refreshToken: null };
const closed: Env = { ...env, SIGNUP_OPEN: 'false', OWNER_APPLE_SUB: undefined };
const open: Env = { ...env, SIGNUP_OPEN: 'true' };
const users = async () =>
  (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n;

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM auth_identities'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('admission', () => {
  it('open: anyone; closed: first account only; pinned: the owner only', () => {
    expect(admission(open, 'x')).toEqual({ always: true, ifNoUsers: false });
    expect(admission(closed, 'x')).toEqual({ always: false, ifNoUsers: true });
    const pinned = { ...closed, OWNER_APPLE_SUB: ' owner ' };
    expect(admission(pinned, 'owner')).toEqual({ always: true, ifNoUsers: false });
    expect(admission(pinned, 'x')).toEqual({ always: false, ifNoUsers: false });
    // an empty pin is no pin
    expect(admission({ ...closed, OWNER_APPLE_SUB: '' }, 'x')).toEqual({
      always: false,
      ifNoUsers: true,
    });
  });

  it('signupOpen reflects it for /api/me', async () => {
    expect(await signupOpen(open)).toBe(true);
    expect(await signupOpen(closed)).toBe(true); // empty: the first account may still come
    await signInWithApple(closed, who('first'), opts);
    expect(await signupOpen(closed)).toBe(false);
    expect(await signupOpen({ ...closed, OWNER_APPLE_SUB: 'owner' })).toBe(false);
  });
});

describe('signInWithApple, concurrently', () => {
  it('ten different first sign-ins at once while closed: exactly one gets in', async () => {
    const outcomes = await Promise.all(
      Array.from({ length: 10 }, (_, i) => signInWithApple(closed, who(`racer-${i}`), opts)),
    );
    expect(outcomes.filter((o) => o.kind === 'created')).toHaveLength(1);
    expect(outcomes.filter((o) => o.kind === 'closed')).toHaveLength(9);
    expect(await users()).toBe(1);
    const ids = await env.DB.prepare('SELECT COUNT(*) AS n FROM auth_identities').first<{
      n: number;
    }>();
    expect(ids?.n).toBe(1);
  });

  it('the same Apple ID twice at once: one account, both signed in', async () => {
    for (const config of [open, closed]) {
      await env.DB.batch([
        env.DB.prepare('DELETE FROM auth_identities'),
        env.DB.prepare('DELETE FROM users'),
      ]);
      const [a, b] = await Promise.all([
        signInWithApple(config, who('same'), opts),
        signInWithApple(config, who('same'), opts),
      ]);
      if (a.kind === 'closed' || b.kind === 'closed') throw new Error('locked out of own account');
      expect(a.userId).toBe(b.userId);
      expect(await users()).toBe(1);
    }
  });

  it('open sign-up lets everyone in', async () => {
    await Promise.all([1, 2, 3].map((i) => signInWithApple(open, who(`friend-${i}`), opts)));
    expect(await users()).toBe(3);
  });
});
