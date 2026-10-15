/**
 * Who is calling. PR 1 knows only sessions; PR 5 adds personal tokens and
 * OAuth bearer tokens (agents) here, resolved before the cookie.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { defer, type AppEnv } from '../app';
import { apiError } from '../lib/http';
import {
  clearSessionCookie,
  loadSession,
  readSessionCookie,
  setSessionCookie,
  type SessionScope,
} from './session';

export type Scope = 'spots:read' | 'spots:write';

export type Principal =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string; via: 'session'; sessionId: string }
  | {
      kind: 'agent';
      userId: string;
      via: 'oauth' | 'pat';
      clientName: string;
      scopes: Scope[];
    };

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
    }
    await next();
  };
}

export const resolvePrincipal = principalResolver();

/** The prefetched results for `key`, if this request's session lookup carried them. */
export function prefetched(c: Context<AppEnv>, key: string): D1Result[] | null {
  const p = c.var.prefetched;
  return p?.key === key && c.var.principal.kind === 'user' ? p.results : null;
}

/** 401 unless a signed-in human (session). Agents never pass this one. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.principal.kind !== 'user') return apiError(c, 401, 'unauthorized', 'sign in first');
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
