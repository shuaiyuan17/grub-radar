/**
 * A stand-in for appleid.apple.com, for local dev and e2e. Apple only sends
 * people back to https://grub.shuaiyuan.me, so locally the Worker's
 * APPLE_ENDPOINT_BASE (.dev.vars, ignored in production) points here.
 *
 * It behaves like the real thing where it matters to our code: it checks the
 * authorize parameters, verifies our ES256 client_secret against the public
 * half of APPLE_PRIVATE_KEY, issues single-use codes, and signs RS256
 * id_tokens (iss https://appleid.apple.com, aud = client_id, our nonce)
 * published at /auth/keys. The `user` JSON is sent only on a person's first
 * authorization, like Apple.
 *
 * It also stands in for maps-api.apple.com (APPLE_MAPS_BASE): /v1/token
 * checks our ES256 server_api JWT and hands out an access token, /v1/search
 * and /v1/place/:id answer from a few fictional places, in Apple's shape.
 *
 *   node e2e/apple-stub.ts            (port 4599, or APPLE_STUB_PORT)
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  exportJWK,
  generateKeyPair,
  importSPKI,
  jwtVerify,
  SignJWT,
  decodeProtectedHeader,
} from 'jose';

const PORT = Number(process.env.APPLE_STUB_PORT ?? 4599);
const TEAM_ID = 'TMTJYK5V5B';
const KEY_ID = 'BQY23WRKNY';
const CLIENT_ID = 'me.shuaiyuan.grub.web';
const ISSUER = 'https://appleid.apple.com';

function devVar(name: string): string {
  const env = process.env[name];
  if (env) return env;
  const file = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .dev.vars (run npm run dev:vars)`);
  return line
    .slice(name.length + 1)
    .replace(/^"|"$/g, '')
    .replaceAll('\\n', '\n');
}

// public half of the Worker's Apple key, to verify client secrets like Apple does
const clientSecretKey = await importSPKI(
  createPublicKey(devVar('APPLE_PRIVATE_KEY')).export({ type: 'spki', format: 'pem' }).toString(),
  'ES256',
);
const signing = await generateKeyPair('RS256');
const jwks = {
  keys: [{ ...(await exportJWK(signing.publicKey)), kid: 'stub-1', alg: 'RS256', use: 'sig' }],
};

interface Grant {
  sub: string;
  nonce: string;
  redirectUri: string;
  email: string;
}
const codes = new Map<string, Grant>();
const seen = new Set<string>();

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hidden = (fields: Record<string, string>) =>
  Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join('');

function html(res: ServerResponse, status: number, body: string): ServerResponse {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  return res.end(`<!doctype html><meta charset="utf-8"><title>Apple ID (stub)</title>${body}`);
}
function json(res: ServerResponse, status: number, body: unknown): ServerResponse {
  res.writeHead(status, { 'content-type': 'application/json' });
  return res.end(JSON.stringify(body));
}
async function form(req: IncomingMessage): Promise<URLSearchParams> {
  let body = '';
  for await (const chunk of req) body += String(chunk);
  return new URLSearchParams(body);
}

/** What Apple does after the person decides: an auto-submitting form_post. */
function postBack(res: ServerResponse, redirectUri: string, fields: Record<string, string>) {
  return html(
    res,
    200,
    `<form id="f" method="POST" action="${esc(redirectUri)}">${hidden(fields)}<noscript><button>continue</button></noscript></form><script>document.getElementById('f').submit()</script>`,
  );
}

// ---------------------------------------------------------------------------
// Apple Maps Server API (fictional places only)

interface MapsPlace {
  id: string;
  name: string;
  lat: number;
  lng: number;
  lines: string[];
  category: 'Restaurant' | 'Cafe' | 'Bakery';
  words: string[];
}
const MAPS_PLACES: MapsPlace[] = [
  {
    id: 'IE2E00000000000A1',
    name: 'Night Owl Pho',
    lat: 47.6152,
    lng: -122.3201,
    lines: ['101 Lantern St', 'Seattle, WA  98101', 'United States'],
    category: 'Restaurant',
    words: ['pho', 'noodles'],
  },
  {
    id: 'IE2E00000000000A2',
    name: 'Pho Real',
    lat: 47.6101,
    lng: -122.3352,
    lines: ['22 Kettle Ave', 'Seattle, WA 98104', 'United States'],
    category: 'Restaurant',
    words: ['pho'],
  },
  {
    id: 'IE2E00000000000A3',
    name: 'Lantern Pho House',
    lat: 47.5987,
    lng: -122.3239,
    lines: ['415 Paper Lantern Way', 'Seattle, WA 98104', 'United States'],
    category: 'Restaurant',
    words: ['pho', 'noodles'],
  },
  {
    id: 'IE2E00000000000B1',
    name: 'Paper Kite Coffee',
    lat: 47.6123,
    lng: -122.3311,
    lines: ['9 Kite Ln', 'Unit 2', 'Seattle, WA 98101', 'United States'],
    category: 'Cafe',
    words: ['coffee', 'espresso'],
  },
  {
    id: 'IE2E00000000000C1',
    name: 'Little Ember Bakery',
    lat: 47.6188,
    lng: -122.3277,
    lines: ['300 Crumb Way', 'Seattle, WA 98102', 'United States'],
    category: 'Bakery',
    words: ['croissant', 'bakery'],
  },
];
const mapsTokens = new Set<string>();

function mapsWire(p: MapsPlace, withCategory: boolean) {
  return {
    id: p.id,
    name: p.name,
    coordinate: { latitude: p.lat, longitude: p.lng },
    formattedAddressLines: p.lines,
    country: 'United States',
    countryCode: 'US',
    ...(withCategory ? { poiCategory: p.category } : {}),
  };
}

async function verifyMapsJwt(jwt: string) {
  const header = decodeProtectedHeader(jwt);
  if (header.alg !== 'ES256' || header.kid !== KEY_ID || header.typ !== 'JWT')
    throw new Error('bad header');
  const { payload } = await jwtVerify(jwt, clientSecretKey, {
    issuer: TEAM_ID,
    algorithms: ['ES256'],
    requiredClaims: ['iat', 'exp'],
  });
  if (payload.scope !== 'server_api') throw new Error('bad scope');
}

/** Apple Maps Server API routes; null when the path isn't one. */
async function maps(req: IncomingMessage, res: ServerResponse, url: URL) {
  if (req.method !== 'GET' || !url.pathname.startsWith('/v1/')) return null;
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const unauthorized = () => json(res, 401, { error: { message: 'Not Authorized', details: [] } });
  if (url.pathname === '/v1/token') {
    try {
      await verifyMapsJwt(bearer);
    } catch {
      return unauthorized();
    }
    const token = `stub-maps-${crypto.randomUUID()}`;
    mapsTokens.add(token);
    return json(res, 200, { accessToken: token, expiresInSeconds: 1800 });
  }
  if (!mapsTokens.has(bearer)) return unauthorized();
  if (url.pathname === '/v1/search') {
    const p = url.searchParams;
    if (p.has('searchLocation') && p.has('searchRegion'))
      return json(res, 400, {
        error: { message: 'Cannot specify both searchRegion and searchLocation', details: [] },
      });
    const q = (p.get('q') ?? '').toLowerCase();
    const cats = (p.get('includePoiCategories') ?? '').split(',');
    const results = MAPS_PLACES.filter(
      (pl) =>
        cats.includes(pl.category) &&
        [pl.name.toLowerCase(), ...pl.words].some((w) => w.includes(q)),
    ).map((pl) => mapsWire(pl, true));
    return json(res, 200, { displayMapRegion: {}, results });
  }
  const id = /^\/v1\/place\/([^/]+)$/.exec(url.pathname)?.[1];
  const place = id ? MAPS_PLACES.find((pl) => pl.id === decodeURIComponent(id)) : undefined;
  if (place) return json(res, 200, mapsWire(place, false));
  return json(res, 404, { error: { message: 'Not Found', details: [] } });
}

async function verifyClientSecret(secret: string) {
  const header = decodeProtectedHeader(secret);
  if (header.alg !== 'ES256' || header.kid !== KEY_ID) throw new Error('bad header');
  const { payload } = await jwtVerify(secret, clientSecretKey, {
    issuer: TEAM_ID,
    subject: CLIENT_ID,
    audience: ISSUER,
    algorithms: ['ES256'],
  });
  if (!payload.iat || !payload.exp || payload.exp - payload.iat > 15_777_000)
    throw new Error('bad lifetime');
}

const server = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/auth/keys') return json(res, 200, jwks);
    if (await maps(req, res, url)) return;

    if (req.method === 'GET' && url.pathname === '/auth/authorize') {
      const p = Object.fromEntries(url.searchParams);
      const problems = [
        p.client_id !== CLIENT_ID && 'client_id',
        p.response_type !== 'code' && 'response_type',
        p.response_mode !== 'form_post' && 'response_mode',
        p.scope !== 'name email' && 'scope',
        !p.state && 'state',
        !p.nonce && 'nonce',
        !p.redirect_uri?.endsWith('/auth/callback') && 'redirect_uri',
      ].filter(Boolean);
      if (problems.length)
        return html(res, 400, `<h1>invalid_request</h1><p>${esc(problems.join(', '))}</p>`);
      return html(
        res,
        200,
        `<h1>Sign in with Apple (stub)</h1>
<form method="POST" action="/stub/decide">${hidden({ redirect_uri: p.redirect_uri ?? '', state: p.state ?? '', nonce: p.nonce ?? '' })}
<label>Apple ID <input name="who" value="tess"></label>
<button name="decision" value="continue">Continue</button>
<button name="decision" value="cancel">Cancel</button></form>`,
      );
    }

    if (req.method === 'POST' && url.pathname === '/stub/decide') {
      const f = await form(req);
      const redirectUri = f.get('redirect_uri') ?? '';
      const state = f.get('state') ?? '';
      if (f.get('decision') === 'cancel')
        return postBack(res, redirectUri, { error: 'user_cancelled_authorize', state });
      const who = (f.get('who') ?? 'tess').toLowerCase().replace(/[^a-z0-9]/g, '') || 'tess';
      const sub = `000123.stub-${who}.0001`;
      const code = `c${crypto.randomUUID().replaceAll('-', '')}.0.stub`;
      codes.set(code, {
        sub,
        nonce: f.get('nonce') ?? '',
        redirectUri,
        email: `${who}@privaterelay.appleid.com`,
      });
      const fields: Record<string, string> = { code, state };
      if (!seen.has(sub)) {
        seen.add(sub);
        const first = who.charAt(0).toUpperCase() + who.slice(1);
        fields.user = JSON.stringify({
          name: { firstName: first, lastName: 'Stub' },
          email: `${who}@privaterelay.appleid.com`,
        });
      }
      return postBack(res, redirectUri, fields);
    }

    if (req.method === 'POST' && url.pathname === '/auth/token') {
      const f = await form(req);
      if (f.get('client_id') !== CLIENT_ID) return json(res, 400, { error: 'invalid_client' });
      try {
        await verifyClientSecret(f.get('client_secret') ?? '');
      } catch {
        return json(res, 400, { error: 'invalid_client' });
      }
      if (f.get('grant_type') !== 'authorization_code')
        return json(res, 400, { error: 'unsupported_grant_type' });
      const code = f.get('code') ?? '';
      const grant = codes.get(code);
      codes.delete(code); // single use
      if (grant === undefined) return json(res, 400, { error: 'invalid_grant' });
      if (grant.redirectUri !== f.get('redirect_uri'))
        return json(res, 400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const idToken = await new SignJWT({
        nonce: grant.nonce,
        nonce_supported: true,
        email: grant.email,
        email_verified: 'true',
        is_private_email: 'true',
        auth_time: now,
      })
        .setProtectedHeader({ alg: 'RS256', kid: 'stub-1' })
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .setSubject(grant.sub)
        .setIssuedAt(now)
        .setExpirationTime(now + 600)
        .sign(signing.privateKey);
      return json(res, 200, {
        access_token: 'stub-access',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: `stub-refresh-${grant.sub}`,
        id_token: idToken,
      });
    }

    json(res, 404, { error: 'not_found' });
  })().catch((e: unknown) => {
    console.error(e);
    json(res, 500, { error: 'stub_error' });
  });
});

server.listen(PORT, () => {
  console.log(`apple stub on http://localhost:${PORT}`);
});
