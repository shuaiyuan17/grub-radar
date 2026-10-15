/**
 * grub as its own OAuth 2.1 authorization server (workers-oauth-provider,
 * the 1.x split API), in this same Worker. Two protected resources, so a
 * token is only ever good for one of them:
 *
 *   <origin>/mcp   the MCP server (worker/agents/mcp.ts)
 *   <origin>/api   the REST API, for an agent that does OAuth but not MCP
 *
 * A personal API token (`grub_pat_…`, D1) works on both.
 *
 * KV write budget (1,000/day on the free plan): a connection costs about four
 * writes (consent, grant, code exchange), a refresh two. Access tokens last 4
 * hours and refresh tokens slide (30 days idle), so a busy agent costs ~12
 * writes a day. Revocation is still immediate: every request reads the token
 * record, and revoking deletes it. "Last used" is kept in D1, not KV.
 */
import {
  OAuthAuthorizationServer,
  OAuthResourceServer,
  type ValidatedAccessToken,
} from '@cloudflare/workers-oauth-provider';
import type { Context } from 'hono';
import { AGENT_SCOPES, agentName, agentScopes } from '../../src/contracts/agents';
import { defer, type AppEnv } from '../app';
import type { AgentPrincipal } from '../auth/principal';
import { publicOrigin } from '../auth/siwa';
import { findToken, touchGrant, touchToken, USED_EVERY_MS } from '../db/agents';
import { isDevelopment, type Env } from '../env';

/** Everything the authorization server can grant (`friends:read` is reserved, not here). */
export const GRANTABLE_SCOPES = [...AGENT_SCOPES, 'offline_access'] as const;
/**
 * What clients should ask for up front: both, so one consent covers adding
 * spots. The person can untick "add and edit" on the consent page; a write
 * with a read-only token then gets a 403 step-up challenge.
 */
export const REQUIRED_SCOPES = [...AGENT_SCOPES];

export const ACCESS_TOKEN_TTL_S = 4 * 60 * 60;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 60 * 60;
/** Dynamic client registrations allowed per UTC day, across everyone (each is a KV write). */
export const REGISTRATIONS_PER_DAY = 50;

/** What completeAuthorization() stores with a grant (encrypted in KV). */
export interface AgentProps {
  userId: string;
  clientName: string;
}

/** The canonical resource identifiers for an origin. */
export const resourcesFor = (origin: string) => ({
  mcp: `${origin}/mcp`,
  api: `${origin}/api`,
});

/** The origin agents see: PUBLIC_ORIGIN (in development, the request's own). */
export const agentOrigin = (c: Context<AppEnv>) => publicOrigin(c.env, c.req.url);

const servers = new Map<string, OAuthAuthorizationServer<Env>>();

/** The authorization server for `origin` (one per isolate per origin: config is fixed). */
export function authServer(origin: string): OAuthAuthorizationServer<Env> {
  let server = servers.get(origin);
  if (!server) {
    const { mcp, api } = resourcesFor(origin);
    server = new OAuthAuthorizationServer<Env>({
      issuer: origin,
      resources: [mcp, api],
      // a client that names no resource is an MCP client (the door almost everyone uses)
      defaultResource: mcp,
      clientRegistrationEndpoint: '/oauth/register',
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [...GRANTABLE_SCOPES],
      accessTokenTTL: ACCESS_TOKEN_TTL_S,
      refreshTokenTTL: REFRESH_TOKEN_TTL_S,
      refreshTokenIdleTTL: REFRESH_TOKEN_TTL_S,
      onError: ({ code, status, internal }) => {
        // never the request or any token: just what failed
        if (status >= 500) console.error('oauth error', { code, status, reason: internal.reason });
      },
    });
    servers.set(origin, server);
  }
  return server;
}

const apiResources = new Map<string, OAuthResourceServer<Env>>();

/**
 * The REST API as an OAuth resource. Only its RFC 9728 metadata is served
 * from here (/.well-known/oauth-protected-resource/api); REST requests
 * themselves resolve their bearer token in the principal middleware.
 */
export function apiResource(origin: string): OAuthResourceServer<Env> {
  let server = apiResources.get(origin);
  if (!server) {
    server = new OAuthResourceServer<Env>({
      resourceMetadata: {
        resource: resourcesFor(origin).api,
        authorization_servers: [origin],
        bearer_methods_supported: ['header'],
        resource_name: 'grub radar REST API',
      },
      requiredScopes: REQUIRED_SCOPES,
      validateToken: () => () => Promise.resolve(null),
      handler: { fetch: () => new Response(null, { status: 404 }) },
    });
    apiResources.set(origin, server);
  }
  return server;
}

/** "Bearer <token>" -> token, else null. */
export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  return m?.[1] ?? null;
}

// grant id -> when this isolate last recorded its use (spares a D1 write per request)
const grantTouched = new Map<string, number>();

/**
 * Who a bearer token speaks for, at `resource`: a personal token (any
 * resource of ours), or an OAuth access token issued for exactly that
 * resource. Records the use (at most hourly) after the response. null when
 * the token is unknown, expired, revoked or for another resource.
 */
export async function agentFromToken(
  c: Context<AppEnv>,
  resource: string,
  token: string,
  now = Date.now(),
): Promise<AgentPrincipal | null> {
  const db = c.env.DB;
  const pat = await findToken(db, token);
  if (pat) {
    const last = pat.lastUsedAt ? Date.parse(pat.lastUsedAt) : 0;
    if (now - last >= USED_EVERY_MS) defer(c, touchToken(db, pat.id, now).run());
    return {
      kind: 'agent',
      via: 'pat',
      credentialId: pat.id,
      userId: pat.userId,
      clientName: agentName(pat.name),
      scopes: pat.scopes,
    };
  }
  if (token.startsWith('grub_pat_')) return null;
  const valid: ValidatedAccessToken<Partial<AgentProps>> | null = await authServer(
    resourceOrigin(resource),
  ).validateToken(resource, token, c.env);
  if (!valid?.userId) return null;
  // tokens are `<userId>:<grantId>:<secret>`; this one was just validated
  const grantId = token.split(':')[1] ?? '';
  if (grantId && now - (grantTouched.get(grantId) ?? 0) >= USED_EVERY_MS) {
    grantTouched.set(grantId, now);
    defer(c, touchGrant(db, grantId, valid.userId, now).run());
  }
  return {
    kind: 'agent',
    via: 'oauth',
    credentialId: grantId,
    userId: valid.userId,
    clientName: agentName(valid.props.clientName ?? ''),
    scopes: agentScopes(valid.scope),
  };
}

const resourceOrigin = (resource: string) => new URL(resource).origin;

/**
 * Per-IP brake on the OAuth server's public endpoints (OAUTH_LIMITER). As
 * with the sign-in callback, only a development Worker goes without an IP.
 */
export async function oauthAllowed(c: Context<AppEnv>): Promise<boolean> {
  const ip = c.req.header('cf-connecting-ip');
  if (!ip && isDevelopment(c.env)) return true;
  const { success } = await c.env.OAUTH_LIMITER.limit({ key: `oauth:${ip ?? 'unknown'}` });
  return success;
}
