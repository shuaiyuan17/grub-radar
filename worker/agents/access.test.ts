/**
 * Who may call what: every API route against every kind of caller. Agents
 * (a personal token or an OAuth token for /api) reach exactly the spot and
 * place routes, within their scopes; everything else is the person's own,
 * by session only. An /mcp token is no good on /api.
 */
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CreatedTokenSchema } from '../../src/contracts/agents';
import { connectAgent } from '../test/agents';
import { call, ORIGIN, send, userSession, writeHeaders } from '../test/helpers';

type Kind = 'read' | 'write' | 'session' | 'hidden';

/** Every API route. `hidden`: answers 404 to anyone but the right session (admin, a photo). */
const ROUTES: [string, string, Kind][] = [
  ['GET', '/api/spots', 'read'],
  ['GET', '/api/spots/nearby?origin=1,2', 'read'],
  ['GET', '/api/spots/p-x', 'read'],
  ['POST', '/api/roll', 'read'],
  ['GET', '/api/places/search?q=pho&near=1,2', 'read'],
  ['POST', '/api/places/search', 'read'],
  ['GET', '/api/places/IFAKE', 'read'],
  ['POST', '/api/spots', 'write'],
  ['PATCH', '/api/spots/p-x', 'write'],
  ['POST', '/api/spots/p-x/been', 'write'],
  ['POST', '/api/spots/p-x/notes', 'write'],
  // removing a spot (and its photos) is the person's alone
  ['DELETE', '/api/spots/p-x', 'session'],
  ['POST', '/api/spots/import-demo', 'write'],
  ['GET', '/api/me', 'session'],
  ['PATCH', '/api/me', 'session'],
  ['PUT', '/api/me/home', 'session'],
  ['DELETE', '/api/me/home', 'session'],
  ['GET', '/api/me/agents', 'session'],
  ['DELETE', '/api/me/agents/g1', 'session'],
  ['GET', '/api/me/tokens', 'session'],
  ['POST', '/api/me/tokens', 'session'],
  ['DELETE', '/api/me/tokens/pat_x', 'session'],
  ['GET', '/api/mapkit-token', 'session'],
  ['GET', '/api/friends', 'session'],
  ['GET', '/api/friends/places', 'session'],
  ['GET', '/api/friends/u_x/spots', 'session'],
  ['DELETE', '/api/friends/u_x', 'session'],
  ['GET', '/api/invites', 'session'],
  ['POST', '/api/invites', 'session'],
  ['POST', '/api/invites/preview', 'session'],
  ['POST', '/api/invites/accept', 'session'],
  ['DELETE', '/api/invites/inv_x', 'session'],
  ['GET', '/api/photos', 'session'],
  ['POST', '/api/photos', 'session'],
  ['PATCH', '/api/photos/ph_x', 'session'],
  ['DELETE', '/api/photos/ph_x', 'session'],
  ['GET', '/api/photos/ph_x', 'hidden'],
  ['GET', '/api/admin/stats', 'hidden'],
];

interface Caller {
  name: string;
  auth: () => Record<string, string>;
  kind: 'anonymous' | 'session' | 'agent' | 'bad';
  write?: boolean;
}

let session = '';
const tokens: Record<string, string> = {};

const BODY = '{}';

function request(method: string, path: string, headers: Record<string, string>) {
  // a photo upload is image bytes, not JSON (its CSRF check wants an image type)
  const type = path === '/api/photos' && method === 'POST' ? { 'content-type': 'image/webp' } : {};
  return call(path, {
    method,
    headers: { ...(method === 'GET' ? {} : writeHeaders), ...type, ...headers },
    ...(method === 'GET' ? {} : { body: BODY }),
  });
}

beforeAll(async () => {
  session = await userSession('u_matrix', 'Mo');
  for (const [name, scopes] of [
    ['patRead', ['spots:read']],
    ['patWrite', ['spots:read', 'spots:write']],
  ] as const) {
    const res = await send('POST', '/api/me/tokens', session, { name, scopes });
    tokens[name] = CreatedTokenSchema.parse(await res.json()).secret;
  }
  tokens.oauthRead = (
    await connectAgent(session, { resource: `${ORIGIN}/api`, write: false })
  ).access_token;
  tokens.oauthWrite = (await connectAgent(session, { resource: `${ORIGIN}/api` })).access_token;
  tokens.mcp = (await connectAgent(session)).access_token;
});

const bearer = (name: string) => () => ({ authorization: `Bearer ${tokens[name] ?? ''}` });

const CALLERS: Caller[] = [
  { name: 'nobody', auth: () => ({}), kind: 'anonymous' },
  { name: 'session', auth: () => ({ cookie: session }), kind: 'session' },
  { name: 'personal token (read)', auth: bearer('patRead'), kind: 'agent' },
  { name: 'personal token (read+write)', auth: bearer('patWrite'), kind: 'agent', write: true },
  { name: 'OAuth /api token (read)', auth: bearer('oauthRead'), kind: 'agent' },
  { name: 'OAuth /api token (read+write)', auth: bearer('oauthWrite'), kind: 'agent', write: true },
  { name: 'OAuth /mcp token', auth: bearer('mcp'), kind: 'bad' },
  { name: 'made-up token', auth: () => ({ authorization: 'Bearer grub_pat_nope' }), kind: 'bad' },
  {
    name: 'made-up OAuth token',
    auth: () => ({ authorization: 'Bearer u_x:g_x:zzz' }),
    kind: 'bad',
  },
];

/** What `caller` should get on a `kind` route: an exact status, or "past the door" (not 401/403). */
function expected(caller: Caller, kind: Kind): number | 'through' {
  // an invalid token is refused before routing, the same on every path (so nothing is revealed)
  if (caller.kind === 'bad') return 401;
  if (kind === 'hidden') return 404;
  if (caller.kind === 'anonymous') return 401;
  if (caller.kind === 'session') return 'through';
  if (kind === 'session') return 403;
  if (kind === 'write' && !caller.write) return 403;
  return 'through';
}

describe.each(CALLERS)('$name', (caller) => {
  it.each(ROUTES)('%s %s', async (method, path, kind) => {
    const res = await request(method, path, caller.auth());
    const want = expected(caller, kind);
    if (want === 'through') expect([401, 403]).not.toContain(res.status);
    else expect(res.status).toBe(want);
  });
});

describe('details', () => {
  it('an agent refused a person-only route is told why, without data', async () => {
    const res = await request('GET', '/api/me', bearer('patWrite')());
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('not an agent');
    expect(body).not.toContain('Mo');
  });

  it('a bearer token decides, whatever cookie comes with it (memo §3.3)', async () => {
    // a person's live cookie doesn't lift an agent to a person
    const withPat = await request('GET', '/api/me', { cookie: session, ...bearer('patRead')() });
    expect(withPat.status).toBe(403);
    // and a bad token isn't rescued by the cookie
    const bad = await request('GET', '/api/spots', {
      cookie: session,
      authorization: 'Bearer nope',
    });
    expect(bad.status).toBe(401);
    // CSRF follows the resolved principal: an agent's JSON write needs no CSRF header
    const write = await call('/api/spots', {
      method: 'POST',
      headers: { cookie: session, ...bearer('patWrite')(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Kite', kind: 'coffee', location: { lat: 47.6, lng: -122.3 } }),
    });
    expect(write.status).toBe(201);
  });

  it('a dead cookie next to a good token: the token decides', async () => {
    const res = await request('GET', '/api/spots', {
      cookie: '__Host-grub_session=stale',
      ...bearer('patRead')(),
    });
    expect(res.status).toBe(200);
  });

  it('agents skip the CSRF header check, but writes must still be JSON', async () => {
    const ok = await call('/api/spots', {
      method: 'POST',
      headers: { ...bearer('patWrite')(), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ondo', kind: 'food', location: { lat: 47.6, lng: -122.3 } }),
    });
    expect(ok.status).toBe(201);
    const form = await call('/api/spots', {
      method: 'POST',
      headers: { ...bearer('patWrite')(), 'content-type': 'text/plain' },
      body: '{}',
    });
    expect(form.status).toBe(403);
  });

  it('a bogus bearer gets an RFC 6750 challenge', async () => {
    const res = await request('GET', '/api/spots', { authorization: 'Bearer nope' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/api"`,
    );
  });

  it('every agent request counts against its credential (AGENT_LIMITER)', async () => {
    const limit = vi.spyOn(env.AGENT_LIMITER, 'limit').mockResolvedValue({ success: false });
    try {
      const res = await request('GET', '/api/spots', bearer('patRead')());
      expect(res.status).toBe(429);
      expect(limit).toHaveBeenCalledWith({
        key: expect.stringMatching(/^agent:pat:pat_/) as unknown,
      });
      // a person's session isn't an agent: not braked by it
      expect((await request('GET', '/api/spots', { cookie: session })).status).toBe(200);
    } finally {
      limit.mockRestore();
    }
  });
});
