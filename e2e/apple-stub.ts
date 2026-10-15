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
