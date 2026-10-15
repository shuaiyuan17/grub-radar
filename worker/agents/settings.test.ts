/**
 * Personal API tokens and connected agents (settings), the OAuth server's
 * brakes, Client ID Metadata Documents, and the docs agents read.
 */
import { env } from 'cloudflare:workers';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreatedTokenSchema, TOKENS_MAX, TokensResponseSchema } from '../../src/contracts/agents';
import { sha256Hex } from '../lib/crypto';
import { agentSetup } from './docs';
import { INSTRUCTIONS, WRITE_TOOLS } from './mcp';
import { authorizeUrl, connectAgent, openConsent, pkce } from '../test/agents';
import { call, ORIGIN, send, userSession } from '../test/helpers';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('personal API tokens', () => {
  let cookie = '';
  beforeAll(async () => {
    cookie = await userSession('u_pat', 'Pat');
  });

  it('shows the secret once and keeps only its hash', async () => {
    const res = await send('POST', '/api/me/tokens', cookie, {
      name: ' grok bot ',
      scopes: ['spots:write'],
    });
    expect(res.status).toBe(201);
    const made = CreatedTokenSchema.parse(await res.json());
    expect(made.secret).toMatch(/^grub_pat_[A-Za-z0-9_-]{43}$/);
    // write implies read; the name is trimmed
    expect(made.token).toMatchObject({
      name: 'grok bot',
      scopes: ['spots:read', 'spots:write'],
      lastUsedAt: null,
    });
    const row = await env.DB.prepare('SELECT * FROM api_tokens WHERE id = ?')
      .bind(made.token.id)
      .first();
    expect(JSON.stringify(row)).not.toContain(made.secret);
    expect(row?.token_hash).toBe(await sha256Hex(made.secret));
    const list = TokensResponseSchema.parse(
      await (await call('/api/me/tokens', { cookie })).json(),
    );
    expect(JSON.stringify(list)).not.toContain(made.secret);
    expect(list.tokens.map((t) => t.id)).toContain(made.token.id);
  });

  it('records when a token was last used (at most hourly)', async () => {
    const made = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', cookie, { name: 'used', scopes: ['spots:read'] })
      ).json(),
    );
    await call('/api/spots', { headers: { authorization: `Bearer ${made.secret}` } });
    const first = TokensResponseSchema.parse(
      await (await call('/api/me/tokens', { cookie })).json(),
    ).tokens.find((t) => t.id === made.token.id)?.lastUsedAt;
    expect(first).toBeTruthy();
    await call('/api/spots', { headers: { authorization: `Bearer ${made.secret}` } });
    const second = TokensResponseSchema.parse(
      await (await call('/api/me/tokens', { cookie })).json(),
    ).tokens.find((t) => t.id === made.token.id)?.lastUsedAt;
    expect(second).toBe(first);
  });

  it('refuses a bad name or scope, and more than TOKENS_MAX', async () => {
    expect(
      (await send('POST', '/api/me/tokens', cookie, { name: '  ', scopes: ['spots:read'] })).status,
    ).toBe(400);
    expect(
      (await send('POST', '/api/me/tokens', cookie, { name: 'x', scopes: ['friends:read'] }))
        .status,
    ).toBe(400);
    const other = await userSession('u_pat_cap', 'Cap');
    for (let i = 0; i < TOKENS_MAX; i++)
      expect(
        (
          await send('POST', '/api/me/tokens', other, {
            name: `t${String(i)}`,
            scopes: ['spots:read'],
          })
        ).status,
      ).toBe(201);
    expect(
      (await send('POST', '/api/me/tokens', other, { name: 'one more', scopes: ['spots:read'] }))
        .status,
    ).toBe(409);
  });

  it('revoking is yours only, and the token stops working at once', async () => {
    const made = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', cookie, { name: 'gone', scopes: ['spots:read'] })
      ).json(),
    );
    const stranger = await userSession('u_pat_stranger', 'S');
    expect((await send('DELETE', `/api/me/tokens/${made.token.id}`, stranger)).status).toBe(404);
    expect((await send('DELETE', `/api/me/tokens/${made.token.id}`, cookie)).status).toBe(204);
    const res = await call('/api/spots', { headers: { authorization: `Bearer ${made.secret}` } });
    expect(res.status).toBe(401);
  });

  it('a token can not make, list or revoke tokens', async () => {
    const made = CreatedTokenSchema.parse(
      await (
        await send('POST', '/api/me/tokens', cookie, {
          name: 'sneaky',
          scopes: ['spots:read', 'spots:write'],
        })
      ).json(),
    );
    const res = await call('/api/me/tokens', {
      method: 'POST',
      headers: { authorization: `Bearer ${made.secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'child', scopes: ['spots:write'] }),
    });
    expect(res.status).toBe(403);
  });
});

describe('connected agents', () => {
  it("lists only your own grants and won't revoke someone else's", async () => {
    const a = await userSession('u_ga', 'A');
    const b = await userSession('u_gb', 'B');
    await connectAgent(a, { name: 'A agent' });
    const { agents } = await (
      await call('/api/me/agents', { cookie: a })
    ).json<{ agents: { id: string }[] }>();
    expect(agents).toHaveLength(1);
    expect(await (await call('/api/me/agents', { cookie: b })).json()).toEqual({ agents: [] });
    expect((await send('DELETE', `/api/me/agents/${agents[0]?.id ?? ''}`, b)).status).toBe(404);
    expect((await send('DELETE', `/api/me/agents/${agents[0]?.id ?? ''}`, a)).status).toBe(204);
  });

  it('connecting the same client again replaces its grant (no pile-up)', async () => {
    const a = await userSession('u_again', 'Ag');
    const { clientId } = await connectAgent(a, { name: 'Again' });
    // same client, second authorization
    const { challenge } = await pkce();
    const page = await openConsent(authorizeUrl(clientId, challenge), a);
    expect(page.handle).toBeTruthy();
    const { answerConsent } = await import('../test/agents');
    await answerConsent(page.handle ?? '', page.cookie);
    const { agents } = await (
      await call('/api/me/agents', { cookie: a })
    ).json<{ agents: unknown[] }>();
    expect(agents).toHaveLength(1);
  });
});

describe("the OAuth server's brakes", () => {
  it('per client IP on /oauth/* and /authorize', async () => {
    const limit = vi.spyOn(env.OAUTH_LIMITER, 'limit').mockResolvedValue({ success: false });
    const headers = { 'cf-connecting-ip': '203.0.113.9' };
    expect((await call('/oauth/token', { method: 'POST', headers })).status).toBe(429);
    expect((await call('/oauth/register', { method: 'POST', headers })).status).toBe(429);
    expect((await call('/authorize?client_id=x', { headers })).status).toBe(429);
    expect(limit).toHaveBeenCalledWith({ key: 'oauth:203.0.113.9' });
  });

  it('caps new client registrations per IP per day, and for everyone', async () => {
    const register = (ip: string) =>
      call('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
        body: JSON.stringify({
          client_name: 'x',
          redirect_uris: ['https://x.example/cb'],
          token_endpoint_auth_method: 'none',
        }),
      });
    for (let i = 0; i < 5; i++) expect((await register('198.51.100.1')).status).toBe(201);
    expect((await register('198.51.100.1')).status).toBe(429);
    // another IP isn't blocked by the first one
    expect((await register('198.51.100.2')).status).toBe(201);
    // the global cap
    const today = new Date().toISOString().slice(0, 10);
    await env.DB.prepare(
      "INSERT INTO daily_counts (key, day, count) VALUES ('register', ?, 50) ON CONFLICT (key, day) DO UPDATE SET count = 50",
    )
      .bind(today)
      .run();
    expect((await register('198.51.100.3')).status).toBe(429);
    await env.DB.prepare('DELETE FROM daily_counts').run();
  });
});

describe('Client ID Metadata Documents', () => {
  it('a client identified by a URL shows its verified domain on the consent page', async () => {
    const clientId = 'https://agent.example/oauth/client.json';
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new Request(input, init).url;
      if (url === clientId)
        return Promise.resolve(
          Response.json({
            client_id: clientId,
            client_name: 'Example Agent',
            redirect_uris: ['https://agent.example/callback'],
            token_endpoint_auth_method: 'none',
          }),
        );
      return realFetch(input, init);
    });
    const cookie = await userSession('u_cimd', 'Ci');
    const { challenge } = await pkce();
    const page = await openConsent(
      authorizeUrl(clientId, challenge, { redirect: 'https://agent.example/callback' }),
      cookie,
    );
    expect(page.res.status).toBe(200);
    expect(page.html).toContain('published by <b>agent.example</b>');
    expect(page.html).toContain('Example Agent');
  });
});

describe('docs for agents', () => {
  it('/openapi.json covers exactly the agent routes, with schemas from the contracts', async () => {
    const doc = await (
      await call('/openapi.json')
    ).json<{
      openapi: string;
      paths: Record<string, unknown>;
      components: { schemas: Record<string, { type?: string; properties?: object }> };
      servers: { url: string }[];
    }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.servers[0]?.url).toBe(ORIGIN);
    expect(Object.keys(doc.paths).sort()).toEqual([
      '/api/places/search',
      '/api/places/{applePlaceId}',
      '/api/roll',
      '/api/spots',
      '/api/spots/nearby',
      '/api/spots/{id}',
      '/api/spots/{id}/been',
      '/api/spots/{id}/notes',
    ]);
    expect(Object.keys(doc.components.schemas.Spot?.properties ?? {})).toContain('foundBy');
    expect(doc.components.schemas.MarkBeen?.properties).toHaveProperty('verdict');
    expect(JSON.stringify(doc)).not.toMatch(/\/api\/(me|friends|photos|admin|invites)/);
  });

  it('/llms.txt and /agent-setup.md are public and point at this origin', async () => {
    const llms = await call('/llms.txt');
    expect(llms.headers.get('content-type')).toContain('text/plain');
    expect(await llms.text()).toContain(`${ORIGIN}/mcp`);
    const setup = await call('/agent-setup.md');
    expect(setup.headers.get('content-type')).toContain('text/markdown');
    expect(await setup.text()).toContain(`claude mcp add --transport http grub ${ORIGIN}/mcp`);
  });

  it('agent-setup.md lists every tool and asks before acting', () => {
    const md = agentSetup('https://grub.shuaiyuan.me');
    for (const tool of ['list_spots', 'find_nearby', 'roll', 'search_places', ...WRITE_TOOLS])
      expect(md).toContain(`\`${tool}\``);
    expect(md).toContain('Ask before you run anything');
    expect(md).toMatch(/Don't install anything globally/);
    expect(md).not.toMatch(/without asking|npm i(nstall)? -g|sudo /i);
    for (const client of ['Claude Code', 'Codex', 'Cursor', 'Claude desktop'])
      expect(md).toContain(`### ${client}`);
    expect(md).toContain('grub_pat_');
    expect(INSTRUCTIONS.length).toBeGreaterThan(200);
  });
});
