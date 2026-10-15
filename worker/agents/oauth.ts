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
import { AGENT_SCOPES, agentName, agentScopes, PAT_PREFIX } from '../../src/contracts/agents';
import { defer, type AppEnv } from '../app';
import type { AgentPrincipal } from '../auth/principal';
import { publicOrigin } from '../auth/siwa';
import { findToken, isGrantRevoked, touchGrant, touchToken, USED_EVERY_MS } from '../db/agents';
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
/** Dynamic client registrations per UTC day, across everyone (each is a KV write). */
export const REGISTRATIONS_PER_DAY = 50;
/** …and per client IP, so one IP can't use up everyone's. */
export const REGISTRATIONS_PER_IP_PER_DAY = 5;
/** Consent pages one person may open per UTC day (each one is a KV write). */
export const CONSENTS_PER_DAY = 20;

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

/**
 * The library fetches a client's metadata document (CIMD) and JWKS with the
 * default `redirect: 'follow'`, and has no option for it. Its outbound
 * requests carry its own User-Agent, so for exactly those this Worker's fetch
 * doesn't follow redirects: a 3xx is a failed lookup (the library refuses any
 * non-2xx). With global_fetch_strictly_public, nothing private is reachable
 * anyway; this also keeps a client from bouncing us to a third site.
 */
// the fetch functions this module made (identity, not a marker property: wrappers copy those)
const ours = new WeakSet<typeof fetch>();

const fromLibrary = (input: RequestInfo | URL, init?: RequestInit) =>
  (
    new Headers(input instanceof Request ? input.headers : init?.headers).get('user-agent') ?? ''
  ).startsWith('workers-oauth-provider/');

/** Wraps the global fetch (once; again if something replaced it) so the library's requests don't follow redirects. */
export function noRedirectsForLibrary() {
  const current = globalThis.fetch;
  if (ours.has(current)) return;
  const wrapped = ((input: RequestInfo | URL, init?: RequestInit) =>
    fromLibrary(input, init)
      ? current(input, { ...init, redirect: 'manual' })
      : current(input, init)) as typeof fetch;
  ours.add(wrapped);
  globalThis.fetch = wrapped;
}

const servers = new Map<string, OAuthAuthorizationServer<Env>>();

/** The authorization server for `origin` (one per isolate per origin: config is fixed). */
export function authServer(origin: string): OAuthAuthorizationServer<Env> {
  noRedirectsForLibrary();
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

/** What workers-oauth-provider issues: `<userId>:<grantId>:<secret>`. Anything else never reaches KV. */
const OAUTH_TOKEN = /^[A-Za-z0-9_-]{1,64}:[A-Za-z0-9_-]{8,64}:[A-Za-z0-9_-]{24,128}$/;

// client IP -> refused until (ms): set when BEARER_FAIL_LIMITER says an IP sent too many bad tokens
const throttled = new Map<string, number>();
const THROTTLE_MS = 60_000;

/**
 * Brake on bad bearer tokens per client IP (they'd otherwise cost a KV read
 * each). A failure is counted with BEARER_FAIL_LIMITER; past its limit the IP
 * is refused, before any lookup, for a minute (in this isolate).
 */
function clientIp(c: Context<AppEnv>): string | null {
  return c.req.header('cf-connecting-ip') ?? (isDevelopment(c.env) ? null : 'unknown');
}
async function countFailure(c: Context<AppEnv>, now: number) {
  const ip = clientIp(c);
  if (!ip) return;
  const { success } = await c.env.BEARER_FAIL_LIMITER.limit({ key: `bearer-fail:${ip}` });
  if (!success) throttled.set(ip, now + THROTTLE_MS);
}
function isThrottled(c: Context<AppEnv>, now: number): boolean {
  const ip = clientIp(c);
  const until = ip ? throttled.get(ip) : undefined;
  if (until === undefined) return false;
  if (until > now) return true;
  throttled.delete(ip ?? '');
  return false;
}

/**
 * Who a bearer token speaks for, at `resource`: a personal token (any
 * resource of ours), or an OAuth access token issued for exactly that
 * resource whose grant hasn't been disconnected (checked in D1, strongly
 * consistent, alongside the KV read). Records the use (at most hourly)
 * after the response. null when the token is unknown, malformed, expired,
 * revoked or for another resource; 'throttled' when this IP sent too many
 * bad tokens lately (nothing was looked up).
 */
export async function agentFromToken(
  c: Context<AppEnv>,
  resource: string,
  token: string,
  now = Date.now(),
): Promise<AgentPrincipal | null | 'throttled'> {
  if (isThrottled(c, now)) return 'throttled';
  const db = c.env.DB;
  if (token.startsWith(PAT_PREFIX)) {
    const pat = await findToken(db, token);
    if (!pat) {
      await countFailure(c, now);
      return null;
    }
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
  if (!OAUTH_TOKEN.test(token)) {
    await countFailure(c, now);
    return null;
  }
  const grantId = token.split(':')[1] ?? '';
  const [valid, revoked]: [ValidatedAccessToken<Partial<AgentProps>> | null, boolean] =
    await Promise.all([
      authServer(resourceOrigin(resource)).validateToken(resource, token, c.env),
      isGrantRevoked(db, grantId),
    ]);
  if (!valid?.userId || revoked) {
    await countFailure(c, now);
    return null;
  }
  if (now - (grantTouched.get(grantId) ?? 0) >= USED_EVERY_MS) {
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
