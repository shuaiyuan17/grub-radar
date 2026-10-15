/**
 * The remote MCP server at /mcp: stateless (`createMcpHandler`, a fresh
 * server per request, no Durable Object), behind an OAuth resource server
 * that accepts this Worker's own OAuth tokens for <origin>/mcp and personal
 * API tokens. Every tool is a thin adapter over the same services the REST
 * routes call, acting as the token's user with the token's scopes.
 *
 * Scopes: every request needs spots:read; the write tools need spots:write,
 * and a call to one without it gets a 403 step-up challenge (so the client
 * can ask the person again) before any MCP processing.
 */
import {
  insufficientScope,
  OAuthError,
  OAuthResourceServer,
  type OAuthResourceContext,
} from '@cloudflare/workers-oauth-provider';
import { McpServer } from '@modelcontextprotocol/server';
import { createMcpHandler } from 'agents/mcp/server';
import type { Context } from 'hono';
import * as z from 'zod';
import { foundByAgent } from '../../src/contracts/agents';
import { AddApplePlaceSchema, AddByQuerySchema } from '../../src/contracts/places';
import { NEARBY_DEFAULT_LIMIT, NEARBY_MAX_LIMIT } from '../../src/contracts/spots';
import { AddNoteSchema, MarkBeenSchema, SpotOpError } from '../../src/domain/edits';
import { KINDS, LIMITS, PRICES, VERDICTS, type Spot } from '../../src/domain/spot';
import { executionCtx, type AppEnv } from '../app';
import { agentAllowed, type AgentPrincipal } from '../auth/principal';
import { D1SpotRepository } from '../db/spots';
import type { Env } from '../env';
import { describeIssue } from '../lib/http';
import { overSearchLimit, appleMapsFor } from '../routes/places';
import { AppleMapsError } from '../services/appleMaps';
import {
  addSpot,
  AmbiguousMatch,
  nearby,
  resolveOrigin,
  resolveSearchCentre,
  rollSpot,
} from '../services/spots';
import { VERSION } from '../version';
import { agentFromToken, agentOrigin, REQUIRED_SCOPES, resourcesFor } from './oauth';

/** The resource server's env: ours, plus the request's Hono context (for timing, defer, limits). */
type McpEnv = Env & { hono: Context<AppEnv> };

/** Tools that change your list (need spots:write). */
export const WRITE_TOOLS = new Set(['add_spot', 'mark_been', 'add_note']);

export const INSTRUCTIONS = `grub radar is one person's list of places to eat: restaurants, coffee and bakeries they have been to or want to try, with their own one-line notes and a good/meh/bad verdict. You act for that person, with the access they approved.

- Spots are identified by "id" (e.g. "p-01j..."). Get ids from list_spots, find_nearby or roll.
- To add a place, prefer search_places then add_spot with the applePlaceId of the right result. add_spot with a free-text "query" adds only a clear match; otherwise it returns candidates for you to pick from.
- "home" as an origin means the person's saved home. You never see where home is: for you, home is the centre of its ~1 km grid cell, so distances from it are approximate (up to ~700 m off). Use explicit coordinates when the person tells you where they are.
- Only mark a spot as been, give a verdict or write notes when the person told you so; write notes in their words. Say "found by" is you: every spot you add is labelled with your name.
- Never invent places, verdicts or opening hours.`;

const LatLng = z
  .object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) })
  .describe('a point in decimal degrees');
const Origin = z
  .union([z.literal('home'), LatLng])
  .describe('"home" (the saved home; never revealed, distances approximate) or a point');
const Kinds = z.array(z.enum(KINDS)).min(1).describe('only these kinds (food, coffee, bakery)');
const MaxMinutes = z.number().positive().max(1440).describe('only spots within this travel time');

const text = (data: unknown) => ({
  content: [{ type: 'text' as const, text: JSON.stringify(data) }],
});
const failure = (code: string, message: string, extra: Record<string, unknown> = {}) => ({
  isError: true,
  content: [
    { type: 'text' as const, text: JSON.stringify({ error: { code, message }, ...extra }) },
  ],
});

/** A spot as list_spots shows it: what an agent needs to talk about it, no coordinates. */
function brief(s: Spot) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    ...(s.cuisine ? { cuisine: s.cuisine } : {}),
    ...(s.price ? { price: s.price } : {}),
    status: s.status,
    ...(s.verdict ? { verdict: s.verdict } : {}),
    ...(s.note ? { note: s.note } : {}),
    tags: s.tags,
    ...(s.order.length ? { order: s.order.map((d) => d.dish) } : {}),
    ...(s.address ? { address: s.address } : {}),
    ...(s.why ? { why: s.why.text } : {}),
    ...(s.myNote ? { notes: s.myNote } : {}),
    ...(s.foundBy ? { foundBy: s.foundBy } : {}),
  };
}

/** Errors any tool may hit, as a tool result (never thrown at the client). */
function toolError(e: unknown) {
  if (e instanceof SpotOpError) return failure(e.code, e.message);
  if (e instanceof AppleMapsError)
    return failure('maps_unavailable', "Apple Maps isn't answering; try again later");
  if (e instanceof AmbiguousMatch)
    return failure('ambiguous', e.message, { candidates: e.candidates });
  throw e;
}

/** The MCP server for one request, acting as `agent`. */
export function buildServer(c: Context<AppEnv>, agent: AgentPrincipal): McpServer {
  const server = new McpServer(
    { name: 'grub-radar', title: 'grub radar', version: VERSION },
    { instructions: INSTRUCTIONS },
  );
  const repo = () =>
    new D1SpotRepository(c.env.DB, agent.userId, {
      foundBy: foundByAgent(agent.clientName),
    });
  // every write tool: the scope again (not only the HTTP step-up), then the brake
  const writeBrake = async () => {
    if (!agent.scopes.includes('spots:write'))
      return failure('forbidden', 'this connection may only read: reconnect and allow adding');
    const { success } = await c.env.WRITE_LIMITER.limit({ key: `write:${agent.userId}` });
    return success ? null : failure('rate_limited', 'slow down');
  };
  const searchBrake = async () =>
    (await overSearchLimit(c)) ? failure('rate_limited', 'slow down') : null;

  server.registerTool(
    'list_spots',
    {
      title: 'List spots',
      description:
        "Everything on the person's list (or only been / want-to-try spots, or some kinds): name, kind, cuisine, status, verdict, their one-line note, tags, dishes to order, longer notes and who found it. Use it to answer questions about their list or to find a spot's id.",
      inputSchema: z.object({
        status: z.enum(['been', 'want']).optional().describe('only spots with this status'),
        kinds: Kinds.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ status, kinds }) => {
      const spots = (await repo().list()).filter(
        (s) => (!status || s.status === status) && (!kinds || kinds.includes(s.kind)),
      );
      return text({ spots: spots.map(brief) });
    },
  );

  server.registerTool(
    'find_nearby',
    {
      title: 'Find nearby spots',
      description:
        'Spots on the list within reach of an origin, closest first, with travel minutes (walk or drive estimate), ring (0: ≤10 min, 1: ≤30, 2: ≤60, 3: road trip) and distance. Use for "where should we eat near home / near here".',
      inputSchema: z.object({
        origin: Origin.default('home'),
        maxMinutes: MaxMinutes.optional(),
        kinds: Kinds.optional(),
        limit: z.number().int().min(1).max(NEARBY_MAX_LIMIT).default(NEARBY_DEFAULT_LIMIT),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ origin, maxMinutes, kinds, limit }) => {
      const from = await resolveOrigin(c.env.DB, agent.userId, origin, { coarse: true });
      if (!from.ok) return failure('no_home', 'no home saved: pass a point as origin');
      return text({
        spots: await nearby(repo(), from, {
          limit,
          ...(maxMinutes ? { maxMinutes } : {}),
          ...(kinds ? { kinds } : {}),
        }),
      });
    },
  );

  server.registerTool(
    'roll',
    {
      title: 'Roll the dice',
      description:
        "Can't decide? One random spot from the list within reach of an origin. Pass previousId to avoid repeating the last pick. Returns null when nothing is within reach.",
      inputSchema: z.object({
        origin: Origin.default('home'),
        maxMinutes: MaxMinutes.optional(),
        kinds: Kinds.optional(),
        previousId: z
          .string()
          .max(100)
          .optional()
          .describe('the last pick, to get a different one'),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ origin, maxMinutes, kinds, previousId }) => {
      const from = await resolveOrigin(c.env.DB, agent.userId, origin, { coarse: true });
      if (!from.ok) return failure('no_home', 'no home saved: pass a point as origin');
      const spot = await rollSpot(repo(), from, {
        ...(maxMinutes ? { maxMinutes } : {}),
        ...(kinds ? { kinds } : {}),
        ...(previousId ? { previousId } : {}),
      });
      return text({ spot });
    },
  );

  server.registerTool(
    'search_places',
    {
      title: 'Search Apple Maps',
      description:
        'Restaurants, cafés and bakeries on Apple Maps matching some words, best match first (up to 10), with applePlaceId, name, address and kind. Searches around "near" (default: around home). Nothing is added: follow up with add_spot.',
      inputSchema: z.object({
        query: z.string().min(2).max(100).describe('a name or a dish, e.g. "serious pie"'),
        near: Origin.optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, near }) => {
      const braked = await searchBrake();
      if (braked) return braked;
      const centre = await resolveSearchCentre(c.env.DB, agent.userId, near, undefined, {
        coarse: true,
      });
      if (!centre.ok) return failure('no_home', 'no home saved: pass a point as near');
      try {
        const places = await appleMapsFor(c).search({
          q: query,
          lang: 'en',
          ...(centre.near ? { near: centre.near } : {}),
        });
        return text({ places });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'add_spot',
    {
      title: 'Add a spot',
      description:
        'Adds a place to the list as "want to try" (unless status says been), labelled as found by you. Give exactly one of: applePlaceId (from search_places; preferred), or query (+ near) to add the clear Apple Maps match. An unclear query adds nothing and returns candidates; ask the person or pick by applePlaceId. Adding a place already on the list changes nothing and returns it.',
      inputSchema: z.object({
        applePlaceId: z.string().max(100).optional(),
        query: z.string().min(2).max(100).optional(),
        near: Origin.optional().describe('where to search for query (default: home)'),
        kind: z.enum(KINDS).optional().describe('default: what Apple Maps says, else food'),
        status: z.enum(['want', 'been']).optional(),
        verdict: z.enum(VERDICTS).optional().describe('only with status "been"'),
        note: z
          .string()
          .max(LIMITS.note)
          .optional()
          .describe("a short one-liner in the person's words"),
        why: z.string().max(LIMITS.why).optional().describe("why it's worth trying (your words)"),
        tags: z.array(z.string().max(LIMITS.tag)).max(LIMITS.tags).optional(),
        order: z
          .array(z.string().max(LIMITS.dish))
          .max(LIMITS.dishes)
          .optional()
          .describe('dishes to order'),
        cuisine: z.string().max(LIMITS.cuisine).optional().describe('e.g. "hand-pulled noodles"'),
        price: z.enum(PRICES).optional().describe('only if known; never guess'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ applePlaceId, query, near, ...extras }) => {
      if ((applePlaceId === undefined) === (query === undefined))
        return failure('bad_request', 'give exactly one of applePlaceId or query');
      const braked = (await writeBrake()) ?? (await searchBrake());
      if (braked) return braked;
      try {
        if (applePlaceId !== undefined) {
          const input = AddApplePlaceSchema.safeParse({ applePlaceId, ...extras });
          if (!input.success) return failure('bad_request', describeIssue(input.error));
          const added = await addSpot(repo(), appleMapsFor(c), {
            form: 'apple',
            input: input.data,
          });
          return text({ spot: added.spot, created: added.created });
        }
        const input = AddByQuerySchema.safeParse({ query, ...extras });
        if (!input.success) return failure('bad_request', describeIssue(input.error));
        const centre = await resolveSearchCentre(c.env.DB, agent.userId, near, undefined, {
          coarse: true,
        });
        if (!centre.ok) return failure('no_home', 'no home saved: pass a point as near');
        if (!centre.near) return failure('need_location', 'pass near: where to search');
        const added = await addSpot(repo(), appleMapsFor(c), {
          form: 'query',
          input: input.data,
          near: centre.near,
        });
        return text({
          spot: added.spot,
          created: added.created,
          alternatives: added.alternatives ?? [],
        });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'mark_been',
    {
      title: 'Mark as been',
      description:
        'Records that the person went to a spot (today, or "on"), with an optional verdict (good, meh, bad) and an optional note in their words, appended to their notes. Only when they told you so.',
      inputSchema: z.object({
        id: z.string().max(100).describe('the spot id'),
        verdict: z
          .enum(VERDICTS)
          .optional()
          .describe('how it was; left out, any earlier verdict stays'),
        on: z.iso.date().optional().describe('the day they went, YYYY-MM-DD (default today)'),
        note: z.string().max(LIMITS.entry).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, ...rest }) => {
      const input = MarkBeenSchema.safeParse(rest);
      if (!input.success) return failure('bad_request', describeIssue(input.error));
      const braked = await writeBrake();
      if (braked) return braked;
      try {
        return text({ spot: await repo().markBeen(id, input.data) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    'add_note',
    {
      title: 'Add a note',
      description:
        'Appends a dated line to a spot\'s notes ("— 2026-10-14: get the cumin lamb"). Use the person\'s words.',
      inputSchema: z.object({
        id: z.string().max(100).describe('the spot id'),
        note: z.string().min(1).max(LIMITS.entry),
        on: z.iso.date().optional().describe('YYYY-MM-DD (default today)'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ id, ...rest }) => {
      const input = AddNoteSchema.safeParse(rest);
      if (!input.success) return failure('bad_request', describeIssue(input.error));
      const braked = await writeBrake();
      if (braked) return braked;
      try {
        return text({ spot: await repo().addNote(id, input.data) });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  return server;
}

/** The tool a JSON-RPC body calls, if it's a tools/call (read without consuming the request). */
async function calledTool(request: Request): Promise<string | null> {
  if (request.method !== 'POST') return null;
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const calls = Array.isArray(body) ? body : [body];
  for (const m of calls) {
    if (!m || typeof m !== 'object') continue;
    const { method, params } = m as { method?: unknown; params?: { name?: unknown } };
    if (method === 'tools/call' && typeof params?.name === 'string' && WRITE_TOOLS.has(params.name))
      return params.name;
  }
  return null;
}

async function handle(
  request: Request,
  env: McpEnv,
  ctx: OAuthResourceContext<AgentPrincipal>,
): Promise<Response> {
  const c = env.hono;
  const agent = ctx.props;
  if (!(await agentAllowed(c, agent)))
    return new Response('slow down', { status: 429, headers: { 'retry-after': '60' } });
  if (!agent.scopes.includes('spots:read')) return insufficientScope(ctx.auth, REQUIRED_SCOPES);
  if (!agent.scopes.includes('spots:write') && (await calledTool(request)))
    return insufficientScope(
      ctx.auth,
      REQUIRED_SCOPES,
      'adding and editing spots needs spots:write',
    );
  c.set('principal', agent);
  const mcp = createMcpHandler(() => buildServer(c, agent), { route: '/mcp', corsOptions: false });
  return mcp(request, env, ctx);
}

const servers = new Map<string, OAuthResourceServer<McpEnv, AgentPrincipal>>();

function mcpResource(origin: string): OAuthResourceServer<McpEnv, AgentPrincipal> {
  let server = servers.get(origin);
  if (!server) {
    server = new OAuthResourceServer<McpEnv, AgentPrincipal>({
      resourceMetadata: {
        resource: resourcesFor(origin).mcp,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'grub radar',
      },
      requiredScopes: REQUIRED_SCOPES,
      validateToken: (env) => async (resource, token) => {
        const agent = await agentFromToken(env.hono, resource, token);
        if (agent === 'throttled')
          throw new OAuthError('temporarily_unavailable', {
            description: 'too many bad tokens from here',
            statusCode: 429,
            headers: { 'Retry-After': '60' },
          });
        return agent
          ? { props: agent, audience: resource, scope: agent.scopes, userId: agent.userId }
          : null;
      },
      handler: { fetch: handle },
    });
    servers.set(origin, server);
  }
  return server;
}

/** /mcp and its RFC 9728 metadata (/.well-known/oauth-protected-resource/mcp). */
export function serveMcp(c: Context<AppEnv>): Promise<Response> {
  const env: McpEnv = { ...c.env, hono: c };
  return mcpResource(agentOrigin(c)).fetch(c.req.raw, env, executionCtx(c));
}
