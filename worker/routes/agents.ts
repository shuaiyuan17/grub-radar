/**
 * Settings for the agent door, session-only (an agent can't list, mint or
 * revoke credentials, its own included):
 *
 *   GET    /api/me/agents        your connected OAuth agents (grants)
 *   DELETE /api/me/agents/:id    disconnect one (its tokens stop working at once)
 *   GET    /api/me/tokens        your personal API tokens
 *   POST   /api/me/tokens        make one: the secret comes back once
 *   DELETE /api/me/tokens/:id    revoke one
 */
import type { GrantSummary } from '@cloudflare/workers-oauth-provider';
import { Hono, type Context } from 'hono';
import {
  agentName,
  agentScopes,
  CreateTokenSchema,
  TOKENS_MAX,
  type ConnectedAgent,
} from '../../src/contracts/agents';
import { authServer, agentOrigin } from '../agents/oauth';
import type { AppEnv } from '../app';
import { csrf } from '../auth/csrf';
import { limitWrites, requireSession, sessionUser } from '../auth/principal';
import {
  createToken,
  forgetGrant,
  grantsSeen,
  listTokens,
  revokeGrantStatement,
  revokeToken,
} from '../db/agents';
import { apiError, readJson } from '../lib/http';
import { iso } from '../lib/time';

/** What we store with a grant, readable without decrypting (see authorize.ts). */
export interface GrantMetadata {
  clientName?: string;
  clientDomain?: string;
}

export const agentSettings = new Hono<AppEnv>();

agentSettings.use(requireSession);

const write = [csrf, limitWrites] as const;

/** Every grant of this person's, across pages (a person has a handful). */
async function grantsOf(c: Context<AppEnv>, userId: string): Promise<GrantSummary[]> {
  const oauth = authServer(agentOrigin(c)).getOAuthApi(c.env);
  const out: GrantSummary[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const res = await oauth.listUserGrants(userId, cursor ? { cursor } : {});
    out.push(...res.items);
    cursor = res.cursor;
    if (!cursor) break;
  }
  return out;
}

agentSettings.get('/agents', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const [grants, seen] = await Promise.all([grantsOf(c, userId), grantsSeen(c.env.DB, userId)]);
  const agents: ConnectedAgent[] = grants
    .map((g) => {
      const meta = (g.metadata ?? {}) as GrantMetadata;
      return {
        id: g.id,
        clientName: agentName(meta.clientName ?? '', 'an agent'),
        ...(meta.clientDomain ? { clientDomain: meta.clientDomain } : {}),
        scopes: agentScopes(g.scope),
        createdAt: iso(g.createdAt * 1000),
        lastUsedAt: seen.get(g.id) ?? null,
      };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return c.json({ agents });
});

agentSettings.delete('/agents/:id', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const id = c.req.param('id');
  const grants = await grantsOf(c, userId);
  if (!grants.some((g) => g.id === id)) return apiError(c, 404, 'not_found', 'no such agent');
  // D1 first (strongly consistent: refused everywhere from now on), then KV (eventually)
  await revokeGrantStatement(c.env.DB, id, userId).run();
  await authServer(agentOrigin(c)).getOAuthApi(c.env).revokeGrant(id, userId);
  await forgetGrant(c.env.DB, id, userId);
  return c.body(null, 204);
});

agentSettings.get('/tokens', async (c) => {
  const { userId } = sessionUser(c.var.principal);
  return c.json({ tokens: await listTokens(c.env.DB, userId) });
});

agentSettings.post('/tokens', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const body = await readJson(c, CreateTokenSchema);
  if (!body.ok) return body.res;
  const made = await createToken(c.env.DB, userId, body.data.name, body.data.scopes);
  if (!made)
    return apiError(c, 409, 'conflict', `you can have at most ${String(TOKENS_MAX)} tokens`);
  return c.json(made, 201);
});

agentSettings.delete('/tokens/:id', ...write, async (c) => {
  const { userId } = sessionUser(c.var.principal);
  const gone = await revokeToken(c.env.DB, userId, c.req.param('id'));
  return gone ? c.body(null, 204) : apiError(c, 404, 'not_found', 'no such token');
});
