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
import { admitDaily } from '../db/agents';
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

agentDoor.post('/oauth/register', async (c) => {
  if (!(await oauthAllowed(c))) return apiError(c, 429, 'rate_limited', 'slow down');
  // each registration is a KV write, and anyone may register: a daily cap per IP (so one IP
  // can't use up the day for everyone), then one for everyone
  const ip = c.req.header('cf-connecting-ip') ?? (isDevelopment(c.env) ? null : 'unknown');
  if (ip && !(await admitDaily(c.env.DB, `register:${ip}`, REGISTRATIONS_PER_IP_PER_DAY)))
    return apiError(c, 429, 'rate_limited', 'too many new apps from here today, try tomorrow');
  if (!(await admitDaily(c.env.DB, 'register', REGISTRATIONS_PER_DAY)))
    return apiError(c, 429, 'rate_limited', 'too many new apps today, try tomorrow');
  return toAuthServer(c);
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
