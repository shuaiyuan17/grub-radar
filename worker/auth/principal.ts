/**
 * Who is calling: a person (session cookie), or an agent acting for one (a
 * personal API token, or an OAuth access token issued for /api). Resolved in
 * that order: a live session cookie wins; otherwise a bearer token is tried.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { agentFromToken, agentOrigin, bearerToken, resourcesFor } from '../agents/oauth';
import { defer, type AppEnv } from '../app';
import { apiError } from '../lib/http';
import {
  clearSessionCookie,
  loadSession,
  readSessionCookie,
  setSessionCookie,
  type SessionScope,
} from './session';

/**
 * Agent scopes. `friends:read` is reserved (your friends' shared spots, for an
 * agent of yours) but not wired: no route accepts it yet, and every friends
 * endpoint is session-only.
 */
export type Scope = 'spots:read' | 'spots:write' | 'friends:read';

export interface AgentPrincipal {
  kind: 'agent';
  userId: string;
  via: 'oauth' | 'pat';
  /** The OAuth grant id or the personal token's id: what rate limits key on. */
  credentialId: string;
  /** "Claude Code", "grok bot": stamped as "found by" on spots it adds. */
  clientName: string;
  scopes: Scope[];
}

export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; via: 'session'; sessionId: string }
  | AgentPrincipal;

/**
 * Reads a route wants alongside the session lookup: `key` names them for the
 * handler, `statements` builds them scoped by the session (see SessionScope).
 */
export interface Prefetch {
  key: string;
  statements: (scope: SessionScope) => D1PreparedStatement[];
}

/**
 * Resolves `c.var.principal` for every Worker request. `prefetchFor` may name
 * reads for this request (the hot GETs), which then cost no extra round trip.
 */
export function principalResolver(
  prefetchFor: (c: Context<AppEnv>) => Prefetch | null = () => null,
): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = readSessionCookie(c);
    const prefetch = token ? prefetchFor(c) : null;
    const result = await c.var.timing.measure('session', () =>
      loadSession(c.env.DB, token, Date.now(), {
        ...(prefetch ? { with: prefetch.statements } : {}),
        defer: (work) => {
          defer(c, work);
        },
      }),
    );
    if (result.kind === 'ok') {
      c.set('principal', {
        kind: 'user',
        userId: result.session.userId,
        via: 'session',
        sessionId: result.session.id,
      });
      c.set('account', result.user);
      if (prefetch) c.set('prefetched', { key: prefetch.key, results: result.extras });
      // sliding expiry: re-issue the cookie with the new lifetime
      if (result.refreshed && token)
        setSessionCookie(c, token, result.session.expiresAt - Date.now());
    } else {
      c.set('principal', { kind: 'anonymous' });
      if (result.kind === 'invalid') clearSessionCookie(c);
      const bearer = bearerToken(c.req.header('authorization'));
      if (bearer) {
        const agent = await c.var.timing.measure('agent', () =>
          agentFromToken(c, resourcesFor(agentOrigin(c)).api, bearer),
        );
        if (!agent) return apiError(c, 401, 'unauthorized', 'that token is not valid (any more)');
        if (!(await agentAllowed(c, agent))) return apiError(c, 429, 'rate_limited', 'slow down');
        c.set('principal', agent);
      }
    }
    await next();
  };
}

/** Per-credential brake on everything an agent does (AGENT_LIMITER: 120/min). */
export async function agentAllowed(c: Context<AppEnv>, agent: AgentPrincipal): Promise<boolean> {
  const { success } = await c.env.AGENT_LIMITER.limit({
    key: `agent:${agent.via}:${agent.credentialId}`,
  });
  return success;
}

export const resolvePrincipal = principalResolver();

/** The prefetched results for `key`, if this request's session lookup carried them. */
export function prefetched(c: Context<AppEnv>, key: string): D1Result[] | null {
  const p = c.var.prefetched;
  return p?.key === key && c.var.principal.kind === 'user' ? p.results : null;
}

/**
 * Only a signed-in person (session). Agents never pass: 403 for an agent
 * (its token is fine, this just isn't something an agent may do), 401 for
 * nobody at all.
 */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.var.principal;
  if (p.kind === 'agent')
    return apiError(c, 403, 'forbidden', 'only the person themselves can do this, not an agent');
  if (p.kind !== 'user') return apiError(c, 401, 'unauthorized', 'sign in first');
  await next();
};

export function sessionUser(p: Principal): { userId: string; sessionId: string } {
  if (p.kind !== 'user') throw new Error('requireSession must run first');
  return { userId: p.userId, sessionId: p.sessionId };
}

/**
 * 401 unless a signed-in human, or an agent holding `scope`; 403 for an agent
 * without it. A person's session implicitly has every scope.
 */
export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const p = c.var.principal;
    if (p.kind === 'anonymous') return apiError(c, 401, 'unauthorized', 'sign in first');
    if (p.kind === 'agent' && !p.scopes.includes(scope))
      return apiError(c, 403, 'forbidden', `needs the ${scope} scope`);
    await next();
  };
}

/**
 * Per-user brake on writes (WRITE_LIMITER: 60/min). Run after the auth check,
 * so the key is always a real user. 429 past the limit.
 */
export const limitWrites: MiddlewareHandler<AppEnv> = async (c, next) => {
  const p = c.var.principal;
  if (p.kind !== 'anonymous') {
    const { success } = await c.env.WRITE_LIMITER.limit({ key: `write:${p.userId}` });
    if (!success) return apiError(c, 429, 'rate_limited', 'slow down');
  }
  await next();
};

/** The user whose data this request acts on, and how to label what it adds. */
export function actingUser(p: Principal): { userId: string; foundBy: string } {
  if (p.kind === 'anonymous') throw new Error('requireScope must run first');
  return { userId: p.userId, foundBy: p.kind === 'agent' ? p.clientName : 'me' };
}

/** Is an agent (not the person themselves) asking? Then home is coarse (see services/spots.ts). */
export const isAgent = (c: Context<AppEnv>) => c.var.principal.kind === 'agent';
