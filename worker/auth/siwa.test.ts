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
import { signValue, sha256Hex } from '../lib/crypto';
import { CLIENT_ID, fakeAppleKeys } from '../test/helpers';
import {
  appleBase,
  createClientSecret,
  nameFromUserField,
  normalizePem,
  readStateCookie,
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
    expect(p.state).toMatch(/^[\w-]{43}$/);
    expect(p.nonce).toMatch(/^[\w-]{43}$/);
    expect(p.state).not.toBe(p.nonce);
    // the cookie carries the nonce's hash, not the nonce
    expect(start.cookie).not.toContain(p.nonce);
    const state = await readStateCookie(env, start.cookie, p.state);
    expect(state).toMatchObject({ returnTo: '/radar', nonceHash: await sha256Hex(p.nonce ?? '') });
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

describe('state cookie', () => {
  const now = Date.now();
  const payload = (over = {}) =>
    JSON.stringify({ state: 's1', nonceHash: 'h', returnTo: '/', iat: now, ...over });

  it('accepts its own signed cookie for the matching state', async () => {
    const cookie = await signValue(payload(), env.SESSION_HMAC_KEY);
    expect(await readStateCookie(env, cookie, 's1', now)).not.toBeNull();
  });

  it('rejects a missing cookie, a different state, a forged or tampered cookie', async () => {
    const cookie = await signValue(payload(), env.SESSION_HMAC_KEY);
    expect(await readStateCookie(env, undefined, 's1', now)).toBeNull();
    expect(await readStateCookie(env, cookie, undefined, now)).toBeNull();
    expect(await readStateCookie(env, cookie, 's2', now)).toBeNull();
    const forged = await signValue(payload(), 'some-other-key');
    expect(await readStateCookie(env, forged, 's1', now)).toBeNull();
    const [body, sig] = cookie.split('.');
    const tampered = `${btoa(payload({ returnTo: '//evil' })).replace(/=+$/, '')}.${sig ?? ''}`;
    expect(await readStateCookie(env, tampered, 's1', now)).toBeNull();
    expect(await readStateCookie(env, body ?? '', 's1', now)).toBeNull();
    expect(await readStateCookie(env, 'not.base64!!', 's1', now)).toBeNull();
  });

  it('expires after 10 minutes', async () => {
    const cookie = await signValue(payload(), env.SESSION_HMAC_KEY);
    expect(await readStateCookie(env, cookie, 's1', now + 9 * 60_000)).not.toBeNull();
    expect(await readStateCookie(env, cookie, 's1', now + 11 * 60_000)).toBeNull();
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
