/**
 * CSRF, defence in depth on top of SameSite=Lax (memo §3.2). A state-changing
 * request authenticated by cookie must:
 *   (a) be Content-Type: application/json,
 *   (b) carry X-Grub-Request: 1 (a cross-origin page can't add it without a
 *       CORS preflight, and we never answer preflights),
 *   (c) come from our own origin: Sec-Fetch-Site same-origin|none when the
 *       browser sends it, else Origin equal to ours when present.
 * Requests whose *resolved principal* is an agent (a bearer token, PR 5)
 * skip (b)/(c): a bearer token isn't ambient. A mere Authorization header
 * proves nothing, so it doesn't count. Run after resolvePrincipal.
 */
import type { MiddlewareHandler } from 'hono';
import { CSRF_HEADER } from '../../src/contracts/errors';
import type { AppEnv } from '../app';
import type { Principal } from './principal';
import { apiError } from '../lib/http';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfVerdict = { ok: true } | { ok: false; why: string };

export function checkCsrf(req: Request, principal: Principal['kind']): CsrfVerdict {
  if (SAFE_METHODS.has(req.method)) return { ok: true };
  const h = req.headers;
  if (principal === 'agent') {
    return isJson(h) ? { ok: true } : { ok: false, why: 'content-type' };
  }
  if (!isJson(h)) return { ok: false, why: 'content-type' };
  if (h.get(CSRF_HEADER) !== '1') return { ok: false, why: 'header' };
  const site = h.get('sec-fetch-site');
  if (site !== null) {
    return site === 'same-origin' || site === 'none' ? { ok: true } : { ok: false, why: 'site' };
  }
  const origin = h.get('origin');
  if (origin !== null && origin !== new URL(req.url).origin) return { ok: false, why: 'origin' };
  return { ok: true };
}

function isJson(h: Headers): boolean {
  const type = h.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  return type === 'application/json';
}

export const csrf: MiddlewareHandler<AppEnv> = async (c, next) => {
  const verdict = checkCsrf(c.req.raw, c.var.principal.kind);
  if (!verdict.ok) return apiError(c, 403, 'csrf', `cross-site request refused (${verdict.why})`);
  await next();
};
