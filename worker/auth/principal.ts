/**
 * Who is calling. PR 1 knows only sessions; PR 5 adds personal tokens and
 * OAuth bearer tokens (agents) here, resolved before the cookie.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../app';
import { apiError } from '../lib/http';
import { clearSessionCookie, loadSession, readSessionCookie, setSessionCookie } from './session';

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

/** Resolves `c.var.principal` for every Worker request. */
export const resolvePrincipal: MiddlewareHandler<AppEnv> = async (c, next) => {
  const token = readSessionCookie(c);
  const result = await loadSession(c.env.DB, token);
  if (result.kind === 'ok') {
    c.set('principal', {
      kind: 'user',
      userId: result.session.userId,
      via: 'session',
      sessionId: result.session.id,
    });
    // sliding expiry: re-issue the cookie with the new lifetime
    if (result.refreshed && token)
      setSessionCookie(c, token, result.session.expiresAt - Date.now());
  } else {
    c.set('principal', { kind: 'anonymous' });
    if (result.kind === 'invalid') clearSessionCookie(c);
  }
  await next();
};

/** 401 unless a signed-in human (session). Agents never pass this one. */
export const requireSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.var.principal.kind !== 'user') return apiError(c, 401, 'unauthorized', 'sign in first');
  await next();
};

export function sessionUser(p: Principal): { userId: string; sessionId: string } {
  if (p.kind !== 'user') throw new Error('requireSession must run first');
  return { userId: p.userId, sessionId: p.sessionId };
}
