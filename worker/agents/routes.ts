/**
 * The agent door's public routes (everything in run_worker_first that isn't
 * /api or /auth):
 *
 *   /authorize, /oauth/resume                    consent (authorize.ts)
 *   /oauth/token, /oauth/register                the library's token endpoint and DCR
 *   /.well-known/oauth-authorization-server      RFC 8414 metadata
 *   /.well-known/oauth-protected-resource/mcp    RFC 9728 metadata for /mcp
 *   /.well-known/oauth-protected-resource/api    the same for the REST API
 *   /mcp                                         the MCP server (mcp.ts)
 *   /openapi.json, /llms.txt, /agent-setup.md    docs for agents (docs.ts)
 */
import { Hono, type Context } from 'hono';
import { executionCtx, type AppEnv } from '../app';
import { admitDaily, refundDaily } from '../db/agents';
import { isDevelopment } from '../env';
import { apiError } from '../lib/http';
import { authorize } from './authorize';
import { agentSetup, llmsTxt, openApi } from './docs';
import { serveMcp } from './mcp';
import {
  agentOrigin,
  apiResource,
  authServer,
  oauthAllowed,
  REGISTRATIONS_PER_DAY,
  REGISTRATIONS_PER_IP_PER_DAY,
} from './oauth';

export const agentDoor = new Hono<AppEnv>();

const toAuthServer = (c: Context<AppEnv>) =>
  authServer(agentOrigin(c)).fetch(c.req.raw, c.env, executionCtx(c));

agentDoor.route('/', authorize);

/**
 * Dynamic client registration. Each one is a KV write and anyone may
 * register, so there's a daily cap per IP (one IP can't use up the day for
 * everyone) and one for everyone. A slot is reserved before the provider
 * sees the request (compare-and-set in SQL, so the caps hold under races)
 * and given back if the provider refuses it: malformed registrations cost
 * nothing.
 */
agentDoor.post('/oauth/register', async (c) => {
  if (!(await oauthAllowed(c))) return apiError(c, 429, 'rate_limited', 'slow down');
  const now = Date.now();
  const db = c.env.DB;
  const ip = c.req.header('cf-connecting-ip') ?? (isDevelopment(c.env) ? null : 'unknown');
  const perIp = ip ? `register:${ip}` : null;
  if (perIp && !(await admitDaily(db, perIp, REGISTRATIONS_PER_IP_PER_DAY, now)))
    return apiError(c, 429, 'rate_limited', 'too many new apps from here today, try tomorrow');
  if (!(await admitDaily(db, 'register', REGISTRATIONS_PER_DAY, now))) {
    if (perIp) await refundDaily(db, perIp, now);
    return apiError(c, 429, 'rate_limited', 'too many new apps today, try tomorrow');
  }
  const res = await toAuthServer(c);
  if (res.status !== 201)
    await Promise.all([
      refundDaily(db, 'register', now),
      ...(perIp ? [refundDaily(db, perIp, now)] : []),
    ]);
  return res;
});

agentDoor.all('/oauth/*', async (c) => {
  if (!(await oauthAllowed(c))) return apiError(c, 429, 'rate_limited', 'slow down');
  return toAuthServer(c);
});

agentDoor.get('/.well-known/oauth-authorization-server', toAuthServer);
agentDoor.get('/.well-known/oauth-authorization-server/*', toAuthServer);
agentDoor.get('/.well-known/oauth-protected-resource/mcp', serveMcp);
agentDoor.get('/.well-known/oauth-protected-resource/api', (c) =>
  apiResource(agentOrigin(c)).fetch(c.req.raw, c.env, executionCtx(c)),
);

agentDoor.all('/mcp', serveMcp);
agentDoor.all('/mcp/*', serveMcp);

agentDoor.get('/openapi.json', (c) => c.json(openApi(agentOrigin(c))));
agentDoor.get('/llms.txt', (c) =>
  c.text(llmsTxt(agentOrigin(c)), 200, { 'content-type': 'text/plain; charset=utf-8' }),
);
agentDoor.get('/agent-setup.md', (c) =>
  c.text(agentSetup(agentOrigin(c)), 200, { 'content-type': 'text/markdown; charset=utf-8' }),
);
