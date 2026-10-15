/**
 * The agent door end to end, in workerd: register, authorize (sign-in
 * bounce, consent), token, MCP calls with the official SDK client,
 * disconnect in settings, and then every use of that token refused.
 */
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
} from '@modelcontextprotocol/client';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { ConnectedAgentSchema } from '../../src/contracts/agents';
import {
  answerConsent,
  authorizeUrl,
  connectAgent,
  exchangeCode,
  mcpClient,
  openConsent,
  pkce,
  REDIRECT,
  registerClient,
  toolJson,
  workerFetch,
} from '../test/agents';
import { call, cookieFrom, ORIGIN, send, userSession } from '../test/helpers';

let tess = '';

beforeAll(async () => {
  tess = await userSession('u_tess', 'Tess');
});

describe('discovery', () => {
  it('an unauthenticated MCP request is challenged with the resource metadata', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain(
      `resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(challenge).toContain('scope="spots:read spots:write"');
  });

  it('publishes resource and authorization server metadata', async () => {
    const prm = await (
      await call('/.well-known/oauth-protected-resource/mcp')
    ).json<Record<string, unknown>>();
    expect(prm).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
    const api = await (
      await call('/.well-known/oauth-protected-resource/api')
    ).json<Record<string, unknown>>();
    expect(api).toMatchObject({ resource: `${ORIGIN}/api` });
    const as = await (
      await call('/.well-known/oauth-authorization-server')
    ).json<Record<string, unknown>>();
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ['S256'],
      client_id_metadata_document_supported: true,
    });
    expect(as.scopes_supported).toEqual(['spots:read', 'spots:write', 'offline_access']);
    expect(JSON.stringify(as)).not.toContain('friends:read');
  });

  it('an API 401 points agents at the API resource metadata', async () => {
    const res = await call('/api/spots');
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain(
      '/.well-known/oauth-protected-resource/api',
    );
  });
});

describe('authorize', () => {
  it('signed out: off to Sign in with Apple, then back to the same consent request', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    const res = await call(`${url.pathname}${url.search}`);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/auth/apple/start?returnTo=%2Foauth%2Fresume');
    const pending = cookieFrom(res, '__Host-grub_authz');
    expect(pending).toBeTruthy();
    // the request isn't readable in the cookie
    expect(pending).not.toContain(clientId);
    const back = await call('/oauth/resume', { cookie: pending ?? '' });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe(`/authorize${url.search}`);
  });

  it('a resume without the cookie is an error page, not a redirect', async () => {
    const res = await call('/oauth/resume');
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('expired');
  });

  it('the consent page names the client, its redirect host and the scopes, escaped', async () => {
    const clientId = await registerClient('<img src=x onerror=alert(1)> Agent');
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), tess);
    expect(page.res.status).toBe(200);
    expect(page.html).toContain('&lt;img src=x onerror=alert(1)&gt; Agent');
    expect(page.html).not.toContain('<img src=x');
    expect(page.html).toContain('<b>127.0.0.1</b>');
    expect(page.html).toContain('an app on this computer'); // loopback warning
    expect(page.html).toContain('see your spots and notes');
    expect(page.html).toContain('value="spots:write" checked');
    expect(page.html).toContain('signed in as 🍜 Tess');
    const csp = page.res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("form-action 'self' http://127.0.0.1:43117");
    expect(csp).not.toContain('unsafe-inline');
  });

  it('in Chinese for a Chinese browser', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const url = authorizeUrl(clientId, challenge);
    const res = await call(`${url.pathname}${url.search}`, {
      cookie: tess,
      headers: { 'accept-language': 'zh-CN,zh;q=0.9' },
    });
    const html = await res.text();
    expect(html).toContain('<html lang="zh-Hans">');
    expect(html).toContain('使用你的 grub radar');
  });

  it('an unknown client is shown an error here, never redirected', async () => {
    const { challenge } = await pkce();
    const url = authorizeUrl('nope', challenge);
    const res = await call(`${url.pathname}${url.search}`, { cookie: tess });
    expect(res.status).toBe(400);
    expect(res.headers.get('location')).toBeNull();
  });

  it('"not now" sends the client access_denied', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), tess);
    const res = await answerConsent(page.handle ?? '', page.cookie, { approve: false });
    expect(res.status).toBe(302);
    const to = new URL(res.headers.get('location') ?? '');
    expect(`${to.origin}${to.pathname}`).toBe(REDIRECT);
    expect(to.searchParams.get('error')).toBe('access_denied');
    expect(to.searchParams.get('state')).toBe('st-123');
  });

  it('a consent form posted cross-site is refused', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), tess);
    const res = await call('/authorize', {
      method: 'POST',
      cookie: page.cookie,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'sec-fetch-site': 'cross-site',
      },
      body: new URLSearchParams({ handle: page.handle ?? '', decision: 'approve' }).toString(),
    });
    expect(res.status).toBe(403);
  });

  it('a consent handle without its browser cookie is refused', async () => {
    const clientId = await registerClient();
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), tess);
    const res = await answerConsent(page.handle ?? '', tess); // session, but not the binding cookie
    expect(res.status).toBe(400);
  });

  it('a POST without a session is refused', async () => {
    const res = await answerConsent('whatever', '');
    expect(res.status).toBe(401);
  });

  it('never grants friends:read, even when asked', async () => {
    const t = await connectAgent(tess, {
      scope: 'spots:read spots:write friends:read offline_access',
    });
    expect(t.scope?.split(' ').sort()).toEqual(['offline_access', 'spots:read', 'spots:write']);
  });

  it('unticking "add and edit" grants read only', async () => {
    const t = await connectAgent(tess, { write: false });
    expect(t.scope).toBe('spots:read');
  });

  it('access tokens are short-ish and come with a refresh token', async () => {
    const t = await connectAgent(tess);
    expect(t.expires_in).toBe(4 * 60 * 60);
    expect(t.refresh_token).toBeTruthy();
  });

  it('a code works once', async () => {
    const clientId = await registerClient();
    const { verifier, challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), tess);
    const answer = await answerConsent(page.handle ?? '', page.cookie);
    const code = new URL(answer.headers.get('location') ?? '').searchParams.get('code') ?? '';
    expect((await exchangeCode(clientId, code, verifier)).status).toBe(200);
    expect((await exchangeCode(clientId, code, verifier)).status).toBe(400);
  });
});

describe('the whole flow: connect, use, disconnect, refused', () => {
  it('works end to end with the official MCP client', async () => {
    const owner = await userSession('u_flow', 'Flo');
    await env.DB.prepare(
      "INSERT INTO user_private (user_id, home_lat, home_lng, updated_at) VALUES ('u_flow', 47.61, -122.33, 'x')",
    ).run();
    const t = await connectAgent(owner, { name: 'Claude Code' });

    const client = await mcpClient(t.access_token);
    const tools = (await client.listTools()).tools.map((x) => x.name).sort();
    expect(tools).toEqual([
      'add_dish',
      'add_note',
      'add_spot',
      'find_nearby',
      'list_spots',
      'mark_been',
      'remove_dish',
      'roll',
      'search_places',
    ]);
    // a spot to work with (by hand, through the API with the same token)
    const added = await call('/api/spots', {
      method: 'POST',
      headers: { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ondo', kind: 'food', location: { lat: 47.615, lng: -122.33 } }),
    });
    // an /mcp token is not an /api token
    expect(added.status).toBe(401);

    const been = await client.callTool({
      name: 'list_spots',
      arguments: {},
    });
    expect(toolJson(been)).toEqual({ spots: [] });
    await client.close();

    // the settings page lists it, with its name and scopes
    const list = await call('/api/me/agents', { cookie: owner });
    const { agents } = await list.json<{ agents: unknown[] }>();
    expect(agents).toHaveLength(1);
    const agent = ConnectedAgentSchema.parse(agents[0]);
    expect(agent).toMatchObject({
      clientName: 'Claude Code',
      scopes: ['spots:read', 'spots:write'],
    });
    expect(agent.lastUsedAt).not.toBeNull();

    // disconnect
    expect((await send('DELETE', `/api/me/agents/${agent.id}`, owner)).status).toBe(204);
    const after = await (
      await call('/api/me/agents', { cookie: owner })
    ).json<{ agents: unknown[] }>();
    expect(after.agents).toEqual([]);

    // the access token is dead at once
    const refused = await call('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${t.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(refused.status).toBe(401);
    // and so is the refresh token
    const refresh = await call('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: t.refresh_token ?? '',
        client_id: t.clientId,
      }).toString(),
    });
    expect(refresh.status).toBe(400);
  });

  it('the SDK client does discovery, registration and PKCE on its own', async () => {
    const owner = await userSession('u_sdk', 'Sid');
    const store: {
      client?: { client_id: string };
      tokens?: { access_token: string };
      verifier?: string;
      callback?: URLSearchParams;
    } = {};
    const provider = {
      redirectUrl: REDIRECT,
      clientMetadata: {
        client_name: 'SDK Agent',
        redirect_uris: [REDIRECT],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      clientInformation: () => store.client,
      saveClientInformation: (info: { client_id: string }) => {
        store.client = info;
      },
      tokens: () => store.tokens,
      saveTokens: (tokens: { access_token: string }) => {
        store.tokens = tokens;
      },
      saveCodeVerifier: (v: string) => {
        store.verifier = v;
      },
      codeVerifier: () => store.verifier ?? '',
      // the "browser": the person is signed in, reads the page and allows
      redirectToAuthorization: async (url: URL) => {
        const page = await openConsent(url, owner);
        const answer = await answerConsent(page.handle ?? '', page.cookie);
        store.callback = new URL(answer.headers.get('location') ?? '').searchParams;
      },
    };
    const transport = () =>
      new StreamableHTTPClientTransport(new URL('/mcp', ORIGIN), {
        authProvider: provider as never,
        fetch: workerFetch,
      });
    const first = transport();
    await expect(new Client({ name: 'sdk', version: '1' }).connect(first)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    // the redirect back carries the code and the issuer (RFC 9207), which the SDK checks
    expect(store.callback?.get('iss')).toBe(ORIGIN);
    await first.finishAuth(store.callback ?? new URLSearchParams());
    const client = new Client({ name: 'sdk', version: '1' });
    await client.connect(transport());
    expect((await client.listTools()).tools).toHaveLength(9);
    await client.close();
  });
});
