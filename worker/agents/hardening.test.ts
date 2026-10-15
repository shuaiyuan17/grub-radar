/**
 * Review round on the agent door: agent names can't break a list or pass
 * for someone else, revocation is strongly consistent, an agent's write
 * surface stays small, junk tokens can't drain KV, and "home" is the grid
 * point on every path that searches Apple Maps.
 */
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { env } from 'cloudflare:workers';
import type { Context } from 'hono';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentName, CreatedTokenSchema, TOKEN_NAME_MAX } from '../../src/contracts/agents';
import { roundForSearch } from '../../src/contracts/places';
import { SpotListSchema } from '../../src/contracts/spots';
import type { LatLng } from '../../src/domain/geo';
import type { AppEnv } from '../app';
import type { AgentPrincipal } from '../auth/principal';
import { D1SpotRepository } from '../db/spots';
import { forgetAccessTokens } from '../services/appleMaps';
import { snapToGrid } from '../services/spots';
import {
  answerConsent,
  authorizeUrl,
  connectAgent,
  mcpClient,
  openConsent,
  pkce,
  registerClient,
  toolJson,
} from '../test/agents';
import { fakeAppleMaps, type FakeAppleMaps } from '../test/appleMaps';
import { call, ORIGIN, send, userSession } from '../test/helpers';
import { buildServer } from './mcp';

afterEach(() => {
  vi.restoreAllMocks();
});

const bearer = (t: string, ip?: string) => ({
  authorization: `Bearer ${t}`,
  ...(ip ? { 'cf-connecting-ip': ip } : {}),
});
const list = async (cookie: string) =>
  SpotListSchema.parse(await (await call('/api/spots', { cookie })).json());
const addAs = (token: string, name = 'Ondo') =>
  call('/api/spots', {
    method: 'POST',
    headers: { ...bearer(token), 'content-type': 'application/json' },
    body: JSON.stringify({ name, kind: 'food', location: { lat: 47.6, lng: -122.3 } }),
  });

describe('agent names: bounded, and never a list-breaker', () => {
  const DECOMPOSED = 'é'.repeat(45); // 45 graphemes, 90 UTF-16 units
  const FAMILY = '👩‍👩‍👧‍👦'.repeat(8); // ZWJ sequences, 11 units each
  const LONG = 'x'.repeat(160);

  it.each([
    ['decomposed accents', DECOMPOSED],
    ['ZWJ emoji', FAMILY],
    ['160 units', LONG],
    ['bidi override', '‮evil‬ agent'],
  ])('agentName: %s fits the schema and cuts on whole graphemes', (_, raw) => {
    const name = agentName(raw);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThanOrEqual(TOKEN_NAME_MAX);
    expect(name).not.toMatch(/[‪-‮]/);
    // every grapheme kept is whole
    const whole = [...new Intl.Segmenter().segment(raw.replace(/[‪-‮]/g, ''))].map(
      (s) => s.segment,
    );
    let rebuilt = '';
    for (const g of whole) if (rebuilt.length + g.length <= name.length) rebuilt += g;
    expect(rebuilt.trim()).toBe(name);
  });

  it.each([
    ['decomposed accents', DECOMPOSED],
    ['ZWJ emoji', FAMILY],
    ['160 units', LONG],
  ])('an OAuth client named with %s adds a spot and the list still loads', async (_, name) => {
    const owner = await userSession(`u_name_${name.length}_${name.codePointAt(0) ?? 0}`, 'N');
    const t = await connectAgent(owner, { name, resource: `${ORIGIN}/api` });
    expect((await addAs(t.access_token)).status).toBe(201);
    const res = await call('/api/spots', { cookie: owner });
    expect(res.status).toBe(200);
    const [spot] = SpotListSchema.parse(await res.json());
    expect(spot?.foundBy).toBe(agentName(name));
  });

  it('a bad found_by already in D1 is dropped, not fatal', async () => {
    const owner = await userSession('u_badfound', 'B');
    const made = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', owner, { name: 'ok bot', scopes: ['spots:write'] })
      ).json(),
    );
    await addAs(made.secret);
    await env.DB.prepare("UPDATE user_places SET found_by = ? WHERE user_id = 'u_badfound'")
      .bind(`agent:${'é'.repeat(40)}`)
      .run();
    const res = await call('/api/spots', { cookie: owner });
    expect(res.status).toBe(200);
    const [spot] = SpotListSchema.parse(await res.json());
    expect(spot?.name).toBe('Ondo');
    expect(spot?.foundBy).toBeUndefined();
  });
});

describe('found_by can not be spoofed', () => {
  it.each(['friend:u_bob', 'Claude Code', 'agent:', 'agent:me', `agent:${'e\u0301'.repeat(40)}`])(
    'a repository refuses to stamp %j',
    (foundBy) => {
      expect(() => new D1SpotRepository(env.DB, 'u_x', { foundBy })).toThrow(/found_by/);
    },
  );

  it.each(['me', 'demo', 'agent:Claude Code'])('a repository may stamp %j', (foundBy) => {
    expect(() => new D1SpotRepository(env.DB, 'u_x', { foundBy })).not.toThrow();
  });

  let owner = '';
  beforeAll(async () => {
    owner = await userSession('u_spoof', 'Sp');
  });

  it.each(['me', 'ME', 'demo', 'friend:u_bob', 'agent:x'])(
    'a personal token can not be named %j',
    async (name) => {
      const res = await send('POST', '/api/me/tokens', owner, { name, scopes: ['spots:read'] });
      expect(res.status).toBe(400);
    },
  );

  it('an OAuth client named "me" is "an agent", stored as agent:<name>', async () => {
    const t = await connectAgent(owner, { name: 'me', resource: `${ORIGIN}/api` });
    const added = await addAs(t.access_token, 'Spoof Spot');
    const { id, foundBy } = await added.json<{ id: string; foundBy: string }>();
    expect(foundBy).toBe('an agent');
    const row = await env.DB.prepare('SELECT found_by FROM user_places WHERE place_id = ?')
      .bind(id)
      .first<{ found_by: string }>();
    expect(row?.found_by).toBe('agent:an agent');
  });

  it('the consent page shows the sanitised, bounded name', async () => {
    const clientId = await registerClient(`‮gnirts‬${'y'.repeat(80)}`);
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), owner);
    expect(page.html).not.toMatch(/[‪-‮]/);
    expect(page.html).toContain(`<b>gnirts${'y'.repeat(TOKEN_NAME_MAX - 6)}</b>`);
    expect(page.html).not.toContain('y'.repeat(TOKEN_NAME_MAX));
  });
});

describe('revocation is strongly consistent', () => {
  const rpc = (token: string) =>
    call('/mcp', {
      method: 'POST',
      headers: {
        ...bearer(token),
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });

  it('a grant marked revoked in D1 is refused while KV still has it', async () => {
    const owner = await userSession('u_revoke', 'R');
    const mcp = await connectAgent(owner);
    const api = await connectAgent(owner, { resource: `${ORIGIN}/api` });
    expect((await rpc(mcp.access_token)).status).toBe(200);
    for (const t of [mcp, api]) {
      const grantId = t.access_token.split(':')[1] ?? '';
      await env.DB.prepare(
        "INSERT INTO agent_grants_revoked (grant_id, user_id, revoked_at) VALUES (?, 'u_revoke', 'x')",
      )
        .bind(grantId)
        .run();
      // the grant record is still in KV
      const keys = await env.OAUTH_KV.list({ prefix: `grant:u_revoke:${grantId}` });
      expect(keys.keys).toHaveLength(1);
    }
    expect((await rpc(mcp.access_token)).status).toBe(401);
    expect((await call('/api/spots', { headers: bearer(api.access_token) })).status).toBe(401);
  });

  it('disconnecting writes the D1 marker', async () => {
    const owner = await userSession('u_revoke2', 'R2');
    const t = await connectAgent(owner);
    const grantId = t.access_token.split(':')[1] ?? '';
    expect((await send('DELETE', `/api/me/agents/${grantId}`, owner)).status).toBe(204);
    const row = await env.DB.prepare('SELECT 1 FROM agent_grants_revoked WHERE grant_id = ?')
      .bind(grantId)
      .first();
    expect(row).not.toBeNull();
  });

  it('re-authorizing a client marks its earlier grant revoked in D1', async () => {
    const owner = await userSession('u_reauth', 'Ra');
    const first = await connectAgent(owner, { name: 'Again' });
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(first.clientId, challenge), owner);
    await answerConsent(page.handle ?? '', page.cookie);
    const grantId = first.access_token.split(':')[1] ?? '';
    const row = await env.DB.prepare('SELECT 1 FROM agent_grants_revoked WHERE grant_id = ?')
      .bind(grantId)
      .first();
    expect(row).not.toBeNull();
    expect((await rpc(first.access_token)).status).toBe(401);
  });
});

describe("an agent's write surface", () => {
  let owner = '';
  let token = '';
  let id = '';
  beforeAll(async () => {
    owner = await userSession('u_surface', 'Su');
    token = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', owner, { name: 'bot', scopes: ['spots:write'] })
      ).json(),
    ).secret;
    id = (await (await addAs(token)).json<{ id: string }>()).id;
  });
  const patch = (body: unknown) =>
    call(`/api/spots/${id}`, {
      method: 'PATCH',
      headers: { ...bearer(token), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('may edit the one-liner, tags and such', async () => {
    expect((await patch({ note: 'get the dumplings', tags: ['dumplings'] })).status).toBe(200);
  });

  it.each([{ visibility: 'friends' }, { visibility: 'private' }, { myNote: 'all gone' }])(
    'may not PATCH %j',
    async (body) => {
      const res = await patch(body);
      expect(res.status).toBe(403);
    },
  );

  it('may not remove a spot; the person may', async () => {
    const res = await call(`/api/spots/${id}`, { method: 'DELETE', headers: bearer(token) });
    expect(res.status).toBe(403);
    expect((await list(owner)).map((s) => s.id)).toContain(id);
    expect((await send('DELETE', `/api/spots/${id}`, owner)).status).toBe(204);
  });

  it('the MCP write tools check the scope themselves too', async () => {
    const agent: AgentPrincipal = {
      kind: 'agent',
      via: 'pat',
      credentialId: 'pat_x',
      userId: 'u_surface',
      clientName: 'reader',
      scopes: ['spots:read'],
    };
    const c = { env } as unknown as Context<AppEnv>;
    const [a, b] = InMemoryTransport.createLinkedPair();
    await buildServer(c, agent).connect(b);
    const client = new Client({ name: 't', version: '1' });
    await client.connect(a);
    for (const [name, args] of [
      ['add_note', { id: 'p-x', note: 'x' }],
      ['mark_been', { id: 'p-x' }],
      ['add_spot', { applePlaceId: 'IFAKE' }],
    ] as const) {
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBe(true);
      expect(toolJson(res)).toMatchObject({ error: { code: 'forbidden' } });
    }
    await client.close();
  });
});

describe('KV budget: junk tokens and repeated consents', () => {
  it('a malformed token is refused without a KV read', async () => {
    const get = vi.spyOn(env.OAUTH_KV, 'get');
    for (const junk of ['a:b:c', 'nope', 'x'.repeat(300), 'a:b:c:d:e'])
      expect((await call('/api/spots', { headers: bearer(junk) })).status).toBe(401);
    expect(get).not.toHaveBeenCalled();
  });

  it('past the bad-token limit, an IP is refused before any lookup', async () => {
    const owner = await userSession('u_junk', 'J');
    const good = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', owner, { name: 'g', scopes: ['spots:read'] })
      ).json(),
    ).secret;
    const limit = vi.spyOn(env.BEARER_FAIL_LIMITER, 'limit').mockResolvedValue({ success: false });
    const ip = '192.0.2.77';
    const fake = `u_x:${'g'.repeat(16)}:${'s'.repeat(32)}`;
    expect((await call('/api/spots', { headers: bearer(fake, ip) })).status).toBe(401);
    expect(limit).toHaveBeenCalledWith({ key: `bearer-fail:${ip}` });
    const get = vi.spyOn(env.OAUTH_KV, 'get');
    expect((await call('/api/spots', { headers: bearer(fake, ip) })).status).toBe(429);
    // even a good token from that IP waits out the minute; nothing was looked up
    expect((await call('/api/spots', { headers: bearer(good, ip) })).status).toBe(429);
    expect(get).not.toHaveBeenCalled();
    // other IPs are fine
    expect((await call('/api/spots', { headers: bearer(good, '192.0.2.78') })).status).toBe(200);
  });

  it('a person may open at most 20 consent pages a day', async () => {
    const owner = await userSession('u_consents', 'C');
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO daily_counts (key, day, count) VALUES ('consent:u_consents', ?, 20)",
    )
      .bind(today)
      .run();
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), owner);
    expect(page.res.status).toBe(429);
    expect(page.handle).toBeNull();
  });
});

describe('Client ID Metadata Documents: fetched only after sign-in, never through a redirect', () => {
  const clientId = 'https://agent.example/oauth/client.json';
  it('a signed-out visitor makes us fetch nothing', async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new Request(input, init).url;
      if (url === clientId) seen.push(url);
      return realFetch(input, init);
    });
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge, { redirect: 'https://agent.example/callback' });
    const res = await call(`${url.pathname}${url.search}`);
    expect(res.status).toBe(302);
    expect(seen).toEqual([]);
  });

  it('a metadata URL that redirects is refused (not followed)', async () => {
    // its own URL: validated documents are cached
    const clientId = 'https://agent.example/oauth/bouncing.json';
    const doc = {
      client_id: clientId,
      client_name: 'Bouncing Agent',
      redirect_uris: ['https://agent.example/callback'],
      token_endpoint_auth_method: 'none',
    };
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new Request(input, init).url;
      if (url === clientId)
        // a redirect for a fetch that won't follow it; the document for one that would
        return Promise.resolve(
          init?.redirect === 'manual'
            ? new Response(null, {
                status: 302,
                headers: { location: 'https://elsewhere.example/c' },
              })
            : Response.json(doc),
        );
      return realFetch(input, init);
    });
    const owner = await userSession('u_cimd_redirect', 'Cr');
    const { challenge } = await pkce();
    const page = await openConsent(
      authorizeUrl(clientId, challenge, { redirect: 'https://agent.example/callback' }),
      owner,
    );
    expect(page.res.status).toBe(400);
    expect(page.handle).toBeNull();
  });
});

describe('"home" is the grid point on every path that searches Apple Maps', () => {
  // a home whose 2-decimal search rounding differs from its grid cell's centre's
  const CENTRE = snapToGrid({ lat: 47.612, lng: -122.331 });
  const HOME: LatLng = { lat: CENTRE.lat + 0.004, lng: CENTRE.lng + 0.0058 };
  const where = (p: LatLng) => {
    const r = roundForSearch(p);
    return `${String(r.lat)},${String(r.lng)}`;
  };
  let apple: FakeAppleMaps;
  let owner = '';
  let pat = '';
  beforeEach(async () => {
    forgetAccessTokens();
    apple = await fakeAppleMaps();
  });
  afterEach(() => {
    apple.restore();
  });
  beforeAll(async () => {
    owner = await userSession('u_snap_search', 'Ss');
    await env.DB.prepare(
      "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES ('u_snap_search', ?, ?, 'x')",
    )
      .bind(HOME.lat, HOME.lng)
      .run();
    pat = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', owner, { name: 's', scopes: ['spots:write'] })
      ).json(),
    ).secret;
  });
  const lastNear = () =>
    apple.requests
      .filter((u) => u.pathname === '/v1/search')
      .at(-1)
      ?.searchParams.get('searchLocation');

  it('(the test can tell the two apart)', () => {
    expect(where(snapToGrid(HOME))).not.toBe(where(HOME));
  });

  it('the person searching around home: home itself (rounded)', async () => {
    await call('/api/places/search?q=espresso&near=home', { cookie: owner });
    expect(lastNear()).toBe(where(HOME));
  });

  it('REST search by an agent: the grid point', async () => {
    const res = await call('/api/places/search?q=pho&near=home', { headers: bearer(pat) });
    expect(res.status).toBe(200);
    expect(lastNear()).toBe(where(snapToGrid(HOME)));
  });

  it('REST add-by-query by an agent: the grid point', async () => {
    await call('/api/spots', {
      method: 'POST',
      headers: { ...bearer(pat), 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'night owl pho', near: 'home' }),
    });
    expect(lastNear()).toBe(where(snapToGrid(HOME)));
  });

  it('MCP search_places (and add_spot by query) around home: the grid point', async () => {
    const client = await mcpClient(pat);
    // (a query of its own: searches are cached by query and centre)
    toolJson(await client.callTool({ name: 'search_places', arguments: { query: 'noodles' } }));
    expect(lastNear()).toBe(where(snapToGrid(HOME)));
    await client.callTool({ name: 'add_spot', arguments: { query: 'paper kite' } });
    expect(lastNear()).toBe(where(snapToGrid(HOME)));
    await client.close();
  });
});
