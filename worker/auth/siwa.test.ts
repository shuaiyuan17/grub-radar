import { env } from 'cloudflare:workers';
import {
  createLocalJWKSet,
  decodeProtectedHeader,
  exportJWK,
  generateKeyPair,
  importJWK,
  importPKCS8,
  jwtVerify,
  SignJWT,
} from 'jose';
import { describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { sealValue, sha256Hex } from '../lib/crypto';
import { CLIENT_ID, fakeAppleKeys } from '../test/helpers';
import {
  appleBase,
  createClientSecret,
  nameFromUserField,
  normalizePem,
  openState,
  readState,
  redirectUri,
  safeReturnTo,
  SiwaError,
  startAuthorize,
  verifyIdToken,
} from './siwa';

const apple = await fakeAppleKeys();
const keys = createLocalJWKSet(apple.jwks);
const NONCE = 'the-nonce';
const nonceHash = await sha256Hex(NONCE);
const verify = (token: string, hash = nonceHash) =>
  verifyIdToken(token, { clientId: CLIENT_ID, nonceHash: hash, keys });

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SiwaError) return e.reason;
    throw e;
  }
  return 'accepted';
}

describe('safeReturnTo', () => {
  it.each([
    ['/', '/'],
    ['/place/lucky-thread?x=1', '/place/lucky-thread?x=1'],
    ['/radar#top', '/radar#top'],
    ['//evil.example/x', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example/', '/'],
    ['javascript:alert(1)', '/'],
    ['/auth/apple/start', '/'],
    ['/x\nSet-Cookie: a=b', '/'],
    ['', '/'],
    [undefined, '/'],
  ])('%j -> %j', (input, out) => {
    expect(safeReturnTo(input)).toBe(out);
  });
});

describe('authorize request', () => {
  it('asks Apple for a code via form_post with state + nonce', async () => {
    const start = await startAuthorize(env, 'https://grub.test/auth/apple/start', '/radar');
    const url = new URL(start.url);
    expect(url.origin + url.pathname).toBe('https://appleid.apple.com/auth/authorize');
    const p = Object.fromEntries(url.searchParams);
    expect(p).toMatchObject({
      client_id: 'me.shuaiyuan.grub.web',
      redirect_uri: 'https://grub.test/auth/callback',
      response_type: 'code',
      response_mode: 'form_post',
      scope: 'name email',
    });
    // the state is the sealed payload: opaque, URL-safe, compact
    expect(p.state).toBe(start.state);
    expect(p.state).toMatch(/^[\w-]{16}\.[\w-]+$/);
    expect(p.nonce).toMatch(/^[\w-]{43}$/);
    // it carries the nonce's hash, not the nonce, and nothing readable
    expect(p.state).not.toContain(p.nonce);
    const state = await openState(env, p.state);
    expect(state).toMatchObject({ returnTo: '/radar', nonceHash: await sha256Hex(p.nonce ?? '') });
    expect(state?.jti).toMatch(/^[\w-]{22}$/);
  });

  it('keeps the state short: ~300 chars usually, under 1 KB at the longest returnTo', async () => {
    const prev = await sha256Hex('a session token');
    const usual = await startAuthorize(env, 'https://grub.test/x', '/place/lucky-thread', prev);
    expect(usual.state.length).toBeLessThan(400);
    const longest = await startAuthorize(env, 'https://grub.test/x', `/${'x'.repeat(511)}`, prev);
    expect(longest.state.length).toBeLessThan(1024);
    expect((await openState(env, longest.state))?.returnTo).toHaveLength(512);
  });

  it('encrypts the previous session id: it never shows in the URL', async () => {
    const prev = await sha256Hex('a session token');
    const start = await startAuthorize(env, 'https://grub.test/x', '/', prev);
    expect(start.url).not.toContain(prev);
    expect(start.url).not.toContain(prev.slice(0, 16));
    expect((await openState(env, start.state))?.prevSession).toBe(prev);
  });

  it.each(['production', 'staging', 'Development', '', 'test'])(
    'ENVIRONMENT=%j: registered return URL and the real Apple, whatever the request or vars say',
    (environment) => {
      const notDev: Env = {
        ...env,
        ENVIRONMENT: environment,
        APPLE_ENDPOINT_BASE: 'http://localhost:4599',
        PUBLIC_ORIGIN: 'https://grub.shuaiyuan.me',
      };
      expect(redirectUri(notDev, 'https://evil.example/auth/apple/start')).toBe(
        'https://grub.shuaiyuan.me/auth/callback',
      );
      expect(appleBase(notDev)).toBe('https://appleid.apple.com');
    },
  );

  it('only ENVIRONMENT=development may use the stub and the request origin', () => {
    const dev: Env = {
      ...env,
      ENVIRONMENT: 'development',
      APPLE_ENDPOINT_BASE: 'http://localhost:4599',
    };
    expect(appleBase(dev)).toBe('http://localhost:4599');
    expect(redirectUri(dev, 'http://localhost:5173/x')).toBe('http://localhost:5173/auth/callback');
  });
});

describe('sealed state', () => {
  const now = Date.now();
  const INFO = 'grub-radar siwa state v1';
  const wire = (over = {}) =>
    JSON.stringify({ j: 'jti-0123456789abcdef', n: 'h', r: '/', t: now, ...over });
  const seal = (over = {}, key = env.SESSION_HMAC_KEY) => sealValue(wire(over), key, INFO);

  it('opens its own sealed state', async () => {
    expect(await openState(env, await seal(), now)).toEqual({
      jti: 'jti-0123456789abcdef',
      nonceHash: 'h',
      returnTo: '/',
      iat: now,
    });
  });

  it('rejects a missing, forged, tampered, malformed or oversized state', async () => {
    const good = await seal();
    expect(await openState(env, undefined, now)).toBeNull();
    expect(await openState(env, '', now)).toBeNull();
    expect(await openState(env, await seal({}, 'some-other-key'), now)).toBeNull();
    // one ciphertext character changed
    const i = good.length - 5;
    const flipped = good.slice(0, i) + (good[i] === 'A' ? 'B' : 'A') + good.slice(i + 1);
    expect(await openState(env, flipped, now)).toBeNull();
    expect(await openState(env, good.split('.')[1], now)).toBeNull();
    expect(await openState(env, 'not.base64!!', now)).toBeNull();
    // a random token (the old state format) is not a state
    expect(await openState(env, 'x'.repeat(43), now)).toBeNull();
    // sealed by us but not a state's shape (another purpose, extra fields, short jti)
    expect(await openState(env, await seal({ extra: 1 }), now)).toBeNull();
    expect(await openState(env, await seal({ j: 'short' }), now)).toBeNull();
    expect(
      await openState(env, await sealValue(wire(), env.SESSION_HMAC_KEY, 'other purpose'), now),
    ).toBeNull();
    expect(await openState(env, `${good}${'A'.repeat(2048)}`, now)).toBeNull();
  });

  it('expires after 10 minutes, and is never from the future', async () => {
    const state = await seal();
    expect(await openState(env, state, now + 9 * 60_000)).not.toBeNull();
    expect(await openState(env, state, now + 11 * 60_000)).toBeNull();
    expect(await openState(env, await seal({ t: now + 2 * 60_000 }), now)).toBeNull();
  });

  it('re-checks returnTo on the way out', async () => {
    expect((await openState(env, await seal({ r: '//evil.example' }), now))?.returnTo).toBe('/');
  });
});

describe('readState (the callback check)', () => {
  const now = Date.now();
  const make = () =>
    sealValue(
      JSON.stringify({ j: 'jti-0123456789abcdef', n: 'h', r: '/', t: now }),
      env.SESSION_HMAC_KEY,
      'grub-radar siwa state v1',
    );

  it('with the cookie: it must be exactly the posted state', async () => {
    const state = await make();
    expect((await readState(env, state, state, now))?.path).toBe('cookie');
    const other = await make();
    expect(await readState(env, other, state, now)).toBeNull();
    expect(await readState(env, '', state, now)).toBeNull();
    expect(await readState(env, `${state}x`, state, now)).toBeNull();
  });

  it('without the cookie: a valid sealed state alone', async () => {
    const state = await make();
    expect((await readState(env, undefined, state, now))?.path).toBe('signed-state-only');
    expect(await readState(env, undefined, undefined, now)).toBeNull();
    expect(await readState(env, undefined, 'forged', now)).toBeNull();
    expect(await readState(env, undefined, state, now + 11 * 60_000)).toBeNull();
  });

  it('a matching cookie does not rescue an invalid state', async () => {
    const state = await make();
    expect(await readState(env, state, state, now + 11 * 60_000)).toBeNull();
    expect(await readState(env, 'forged', 'forged', now)).toBeNull();
  });
});

describe('client secret', () => {
  it('is an ES256 JWT Apple will accept: kid, iss=team, sub=client_id, aud=appleid, 5 min', async () => {
    const now = Date.UTC(2026, 9, 14, 22, 0);
    const jwt = await createClientSecret(env, now);
    expect(decodeProtectedHeader(jwt)).toEqual({ alg: 'ES256', kid: 'BQY23WRKNY' });
    const priv = await importPKCS8(normalizePem(env.APPLE_PRIVATE_KEY), 'ES256', {
      extractable: true,
    });
    // the public half of the configured key
    const { kty, crv, x, y } = await exportJWK(priv);
    const pub = await importJWK({ kty, crv, x, y }, 'ES256');
    const { payload } = await jwtVerify(jwt, pub, { currentDate: new Date(now) });
    expect(payload).toEqual({
      iss: 'TMTJYK5V5B',
      sub: 'me.shuaiyuan.grub.web',
      aud: 'https://appleid.apple.com',
      iat: now / 1000,
      exp: now / 1000 + 300,
    });
  });

  it('accepts a PEM with literal \\n escapes', () => {
    expect(normalizePem('-----BEGIN X-----\\nabc\\n-----END X-----\\n')).toBe(
      '-----BEGIN X-----\nabc\n-----END X-----',
    );
  });
});

describe('verifyIdToken', () => {
  it('accepts a genuine token and returns sub + email', async () => {
    const identity = await verify(await apple.idToken({ nonce: NONCE }));
    expect(identity).toEqual({
      sub: '000123.fictional-sub.0456',
      email: 'tess@privaterelay.appleid.com',
      emailIsRelay: true,
    });
  });

  it('handles boolean is_private_email and plain emails', async () => {
    const t = await apple.idToken({
      nonce: NONCE,
      email: 'tess@example.com',
      is_private_email: false,
    });
    expect((await verify(t)).emailIsRelay).toBe(false);
  });

  it('rejects the wrong audience', async () => {
    const t = await apple.idToken({ nonce: NONCE, aud: 'me.shuaiyuan.other' });
    expect(await reason(verify(t))).toBe('id_token');
  });

  it('rejects the wrong issuer', async () => {
    const t = await apple.idToken({ nonce: NONCE, iss: 'https://evil.example' });
    expect(await reason(verify(t))).toBe('id_token');
  });

  it('rejects an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 3600;
    const t = await apple.idToken({ nonce: NONCE, iat: past - 600, exp: past });
    expect(await reason(verify(t))).toBe('id_token');
  });

  it('rejects a nonce mismatch and a missing nonce', async () => {
    expect(await reason(verify(await apple.idToken({ nonce: 'other' })))).toBe('nonce');
    expect(await reason(verify(await apple.idToken()))).toBe('nonce');
  });

  it('rejects a token signed by a key Apple does not publish (unknown kid)', async () => {
    const stranger = await fakeAppleKeys('unknown-kid');
    expect(await reason(verify(await stranger.idToken({ nonce: NONCE })))).toBe('id_token');
  });

  it('rejects a known kid with the wrong key behind it', async () => {
    const impostor = await fakeAppleKeys(apple.kid);
    expect(await reason(verify(await impostor.idToken({ nonce: NONCE })))).toBe('id_token');
  });

  it('only accepts RS256 (no HS256 / alg confusion)', async () => {
    const secret = new TextEncoder().encode('a'.repeat(32));
    const t = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'HS256', kid: apple.kid })
      .setIssuer('https://appleid.apple.com')
      .setAudience(CLIENT_ID)
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(secret);
    expect(await reason(verify(t))).toBe('id_token');
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const esKeys = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), kid: 'es', alg: 'ES256' }],
    });
    const es = await new SignJWT({ nonce: NONCE })
      .setProtectedHeader({ alg: 'ES256', kid: 'es' })
      .setIssuer('https://appleid.apple.com')
      .setAudience(CLIENT_ID)
      .setSubject('x')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    expect(await reason(verifyIdToken(es, { clientId: CLIENT_ID, nonceHash, keys: esKeys }))).toBe(
      'id_token',
    );
  });

  it('rejects garbage', async () => {
    expect(await reason(verify('not-a-jwt'))).toBe('id_token');
  });
});

describe("Apple's one-time user field", () => {
  it.each([
    ['{"name":{"firstName":"Tess","lastName":"Lau"},"email":"x@y"}', 'Tess'],
    ['{"name":{"lastName":"Lau"}}', 'Lau'],
    ['{"name":{"firstName":"  "}}', null],
    ['{"email":"x@y"}', null],
    ['not json', null],
    [undefined, null],
  ])('%j -> %j', (raw, name) => {
    expect(nameFromUserField(raw)).toBe(name);
  });

  it('caps very long names', () => {
    expect(
      nameFromUserField(JSON.stringify({ name: { firstName: 'x'.repeat(100) } })),
    ).toHaveLength(40);
  });
});
