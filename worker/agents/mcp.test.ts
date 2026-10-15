/**
 * The MCP tools, through the official SDK client: thin adapters over the
 * same services as REST, acting as the token's person with its scopes, and
 * stamping "found by" with the agent's name.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreatedTokenSchema } from '../../src/contracts/agents';
import { SpotListSchema } from '../../src/contracts/spots';
import { forgetAccessTokens } from '../services/appleMaps';
import { connectAgent, mcpClient, toolJson } from '../test/agents';
import { fakeAppleMaps, type FakeAppleMaps } from '../test/appleMaps';
import { call, ORIGIN, send, userSession } from '../test/helpers';

let apple: FakeAppleMaps;
beforeEach(async () => {
  forgetAccessTokens();
  apple = await fakeAppleMaps();
});
afterEach(() => {
  apple.restore();
  vi.restoreAllMocks();
});

let owner = '';
let token = '';
beforeAll(async () => {
  owner = await userSession('u_mcp', 'Mia');
  token = (await connectAgent(owner, { name: 'Claude Code' })).access_token;
});

const mySpots = async (cookie = owner) =>
  SpotListSchema.parse(await (await call('/api/spots', { cookie })).json());

describe('the server', () => {
  it('introduces itself with instructions agents can follow', async () => {
    const client = await mcpClient(token);
    expect(client.getServerVersion()?.name).toBe('grub-radar');
    const instructions = client.getInstructions() ?? '';
    expect(instructions).toContain('search_places then add_spot');
    expect(instructions).toContain('never see where home is');
    const tools = (await client.listTools()).tools;
    for (const t of tools) expect(t.description?.length).toBeGreaterThan(60);
    const readOnly = tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name);
    expect(readOnly.sort()).toEqual(['find_nearby', 'list_spots', 'roll', 'search_places']);
    await client.close();
  });
});

describe('tools', () => {
  it('search_places, then add_spot by applePlaceId: found by the agent', async () => {
    const client = await mcpClient(token);
    const found = toolJson(
      await client.callTool({
        name: 'search_places',
        arguments: { query: 'paper kite', near: { lat: 47.61, lng: -122.33 } },
      }),
    ) as { places: { applePlaceId: string; name: string }[] };
    expect(found.places[0]?.name).toBe('Paper Kite Coffee');
    const added = toolJson(
      await client.callTool({
        name: 'add_spot',
        arguments: {
          applePlaceId: found.places[0]?.applePlaceId,
          why: 'flat white people rave about',
        },
      }),
    ) as { spot: { id: string; foundBy?: string; kind: string }; created: boolean };
    expect(added.created).toBe(true);
    expect(added.spot.foundBy).toBe('Claude Code');
    // the person sees it on their list, with the label
    const spot = (await mySpots()).find((s) => s.id === added.spot.id);
    expect(spot?.foundBy).toBe('Claude Code');
    expect(spot?.why?.text).toBe('flat white people rave about');
    await client.close();
  });

  it('add_spot by query: a clear match is added, an unclear one returns candidates', async () => {
    const client = await mcpClient(token);
    const clear = toolJson(
      await client.callTool({
        name: 'add_spot',
        arguments: { query: 'night owl pho', near: { lat: 47.61, lng: -122.33 } },
      }),
    ) as { spot: { name: string } };
    expect(clear.spot.name).toBe('Night Owl Pho');
    const unclear = await client.callTool({
      name: 'add_spot',
      arguments: { query: 'noodles', near: { lat: 47.61, lng: -122.33 } },
    });
    expect(unclear.isError).toBe(true);
    const body = toolJson(unclear) as { error: { code: string }; candidates: unknown[] };
    expect(body.error.code).toBe('ambiguous');
    expect(body.candidates.length).toBeGreaterThan(1);
    const neither = await client.callTool({ name: 'add_spot', arguments: { kind: 'food' } });
    expect(neither.isError).toBe(true);
    await client.close();
  });

  it('mark_been, add_note, list_spots, find_nearby, roll', async () => {
    const client = await mcpClient(token);
    const [spot] = await mySpots();
    if (!spot) throw new Error('no spot');
    const been = toolJson(
      await client.callTool({
        name: 'mark_been',
        arguments: { id: spot.id, verdict: 'good', note: 'loved it' },
      }),
    ) as { spot: { status: string; verdict: string; myNote: string } };
    expect(been.spot).toMatchObject({ status: 'been', verdict: 'good' });
    expect(been.spot.myNote).toMatch(/— \d{4}-\d{2}-\d{2}: loved it/);
    const noted = toolJson(
      await client.callTool({
        name: 'add_note',
        arguments: { id: spot.id, note: 'get the cardamom bun' },
      }),
    ) as { spot: { myNote: string } };
    expect(noted.spot.myNote).toContain('cardamom bun');
    const bad = await client.callTool({
      name: 'mark_been',
      arguments: { id: spot.id, verdict: 'amazing' },
    });
    expect(bad.isError).toBe(true);
    const missing = await client.callTool({
      name: 'add_note',
      arguments: { id: 'p-nope', note: 'x' },
    });
    expect(toolJson(missing)).toMatchObject({ error: { code: 'not_found' } });

    const listed = toolJson(
      await client.callTool({ name: 'list_spots', arguments: { status: 'been' } }),
    ) as {
      spots: { id: string; verdict?: string; location?: unknown }[];
    };
    expect(listed.spots.map((s) => s.id)).toEqual([spot.id]);
    expect(listed.spots[0]?.verdict).toBe('good');

    const near = toolJson(
      await client.callTool({
        name: 'find_nearby',
        arguments: { origin: { lat: 47.61, lng: -122.33 } },
      }),
    ) as { spots: unknown[] };
    expect(near.spots.length).toBeGreaterThan(0);
    const noHome = await client.callTool({ name: 'find_nearby', arguments: {} });
    expect(toolJson(noHome)).toMatchObject({ error: { code: 'no_home' } });
    const rolled = toolJson(
      await client.callTool({ name: 'roll', arguments: { origin: { lat: 47.61, lng: -122.33 } } }),
    ) as { spot: { id: string } | null };
    expect(rolled.spot?.id).toBeTruthy();
    await client.close();
  });

  it('add_dish and remove_dish edit the dishes to order, deduped', async () => {
    const client = await mcpClient(token);
    const [spot] = await mySpots();
    if (!spot) throw new Error('no spot');
    const before = spot.version ?? 0;
    const added = toolJson(
      await client.callTool({
        name: 'add_dish',
        arguments: { id: spot.id, dish: '  Cumin   Lamb Noodles ' },
      }),
    ) as { spot: { version: number }; added: boolean };
    expect(added.added).toBe(true);
    expect(added.spot.version).toBe(before + 1);
    // the person sees it on their list
    let mine = (await mySpots()).find((s) => s.id === spot.id);
    expect(mine?.order.map((d) => d.dish)).toContain('Cumin Lamb Noodles');
    expect(mine?.order.find((d) => d.dish === 'Cumin Lamb Noodles')?.tried).toBe(false);
    expect(mine?.version).toBe(before + 1);

    // the same dish again, in other case and spacing: nothing written
    const again = toolJson(
      await client.callTool({
        name: 'add_dish',
        arguments: { id: spot.id, dish: 'cumin lamb noodles' },
      }),
    ) as { spot: { version: number }; added: boolean };
    expect(again.added).toBe(false);
    expect(again.spot.version).toBe(before + 1);
    mine = (await mySpots()).find((s) => s.id === spot.id);
    expect(mine?.order.filter((d) => /cumin lamb/i.test(d.dish))).toHaveLength(1);

    // list_spots shows it
    const listed = toolJson(await client.callTool({ name: 'list_spots', arguments: {} })) as {
      spots: { id: string; order?: string[] }[];
    };
    expect(listed.spots.find((s) => s.id === spot.id)?.order).toContain('Cumin Lamb Noodles');

    const removed = toolJson(
      await client.callTool({
        name: 'remove_dish',
        arguments: { id: spot.id, dish: 'CUMIN LAMB noodles' },
      }),
    ) as { spot: { order: { dish: string }[]; version: number } };
    expect(removed.spot.order.map((d) => d.dish)).not.toContain('Cumin Lamb Noodles');
    expect(removed.spot.version).toBe(before + 2);
    mine = (await mySpots()).find((s) => s.id === spot.id);
    expect(mine?.order.map((d) => d.dish)).not.toContain('Cumin Lamb Noodles');

    const gone = await client.callTool({
      name: 'remove_dish',
      arguments: { id: spot.id, dish: 'Cumin Lamb Noodles' },
    });
    expect(toolJson(gone)).toMatchObject({ error: { code: 'no_dish' } });
    const tooLong = await client.callTool({
      name: 'add_dish',
      arguments: { id: spot.id, dish: 'x'.repeat(81) },
    });
    expect(tooLong.isError).toBe(true);
    const missing = await client.callTool({
      name: 'add_dish',
      arguments: { id: 'p-nope', dish: 'x' },
    });
    expect(toolJson(missing)).toMatchObject({ error: { code: 'not_found' } });
    await client.close();
  });

  it('add_dish stops at 20 dishes', async () => {
    const client = await mcpClient(token);
    const [spot] = await mySpots();
    if (!spot) throw new Error('no spot');
    const room = 20 - spot.order.length;
    for (let i = 0; i < room; i++)
      expect(
        toolJson(
          await client.callTool({
            name: 'add_dish',
            arguments: { id: spot.id, dish: `filler ${String(i)}` },
          }),
        ),
      ).toMatchObject({ added: true });
    const over = await client.callTool({
      name: 'add_dish',
      arguments: { id: spot.id, dish: 'one too many' },
    });
    expect(toolJson(over)).toMatchObject({ error: { code: 'dishes_full' } });
    expect((await mySpots()).find((s) => s.id === spot.id)?.order).toHaveLength(20);
    await client.close();
  });

  it("an agent only ever sees its own person's list", async () => {
    const other = await userSession('u_mcp_other', 'Oz');
    await send('POST', '/api/spots', other, {
      name: 'Secret Supper',
      kind: 'food',
      location: { lat: 47.6, lng: -122.3 },
    });
    const [theirs] = await mySpots(other);
    const client = await mcpClient(token);
    const listed = JSON.stringify(
      toolJson(await client.callTool({ name: 'list_spots', arguments: {} })),
    );
    expect(listed).not.toContain('Secret Supper');
    const poke = await client.callTool({
      name: 'add_note',
      arguments: { id: theirs?.id, note: 'x' },
    });
    expect(toolJson(poke)).toMatchObject({ error: { code: 'not_found' } });
    const dish = await client.callTool({
      name: 'add_dish',
      arguments: { id: theirs?.id, dish: 'x' },
    });
    expect(toolJson(dish)).toMatchObject({ error: { code: 'not_found' } });
    await client.close();
  });
});

describe('scopes and credentials', () => {
  const rpc = (bearer: string, body: unknown) =>
    call('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify(body),
    });

  it('a read-only token can read, and a write tool gets a 403 step-up challenge', async () => {
    const readOnly = (await connectAgent(owner, { write: false })).access_token;
    const client = await mcpClient(readOnly);
    expect(toolJson(await client.callTool({ name: 'list_spots', arguments: {} }))).toHaveProperty(
      'spots',
    );
    await client.close();
    const res = await rpc(readOnly, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'add_note', arguments: { id: 'p-x', note: 'x' } },
    });
    expect(res.status).toBe(403);
    const challenge = res.headers.get('www-authenticate') ?? '';
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="spots:read spots:write"');
    expect(challenge).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
  });

  it('a personal token works on /mcp too, and its name is the "found by"', async () => {
    const made = await send('POST', '/api/me/tokens', owner, {
      name: 'grok bot',
      scopes: ['spots:read', 'spots:write'],
    });
    const { secret, token: listed } = CreatedTokenSchema.parse(await made.json());
    const client = await mcpClient(secret);
    const added = toolJson(
      await client.callTool({
        name: 'add_spot',
        arguments: { query: 'little ember', near: { lat: 47.61, lng: -122.33 } },
      }),
    ) as { spot: { foundBy?: string } };
    expect(added.spot.foundBy).toBe('grok bot');
    await client.close();
    // revoked: refused at once
    expect((await send('DELETE', `/api/me/tokens/${listed.id}`, owner)).status).toBe(204);
    expect((await rpc(secret, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('an /api token is not an /mcp token', async () => {
    const apiToken = (await connectAgent(owner, { resource: `${ORIGIN}/api` })).access_token;
    expect((await rpc(apiToken, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('a browser page on another site cannot drive /mcp', async () => {
    const res = await call('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        origin: 'https://evil.example',
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}',
    });
    expect(res.status).toBe(403);
    // (the OAuth library answers with CORS headers, but never lets credentials ride along)
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('MCP calls count against the agent brake', async () => {
    const { env } = await import('cloudflare:workers');
    const limit = vi.spyOn(env.AGENT_LIMITER, 'limit').mockResolvedValue({ success: false });
    const res = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(res.status).toBe(429);
    limit.mockRestore();
  });
});
