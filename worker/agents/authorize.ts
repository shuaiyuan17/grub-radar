/**
 * The interactive half of the OAuth server (the library leaves it to us):
 *
 *   GET  /authorize      validate the request; not signed in -> Sign in with
 *                        Apple, then back here; signed in -> the consent page
 *   POST /authorize      the person's answer -> back to the client
 *   GET  /oauth/resume   where Sign in with Apple returns to (see below)
 *
 * The client's request parameters can be longer than a sign-in `returnTo`
 * may be, so while the person signs in they wait in a sealed, 10-minute,
 * SameSite=Lax cookie (__Host-grub_authz); /oauth/resume puts them back.
 *
 * Errors follow the library's rule: redirect to the client only once its
 * client id and exact redirect URI have been validated; render everything
 * else here.
 */
import {
  AuthorizationError,
  CimdFetchError,
  type AuthRequest,
} from '@cloudflare/workers-oauth-provider';
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { agentName } from '../../src/contracts/agents';
import type { AppEnv } from '../app';
import { principalResolver } from '../auth/principal';
import { localeFromAcceptLanguage } from '../auth/signingInPage';
import { openValue, sealValue } from '../lib/crypto';
import type { GrantMetadata } from '../routes/agents';
import { consentCsp, consentErrorPage, consentPage } from './consentPage';
import { agentOrigin, authServer, GRANTABLE_SCOPES, oauthAllowed } from './oauth';

type Ctx = Context<AppEnv>;

const PENDING_COOKIE = '__Host-grub_authz';
const PENDING_INFO = 'grub authorize pending v1';
const PENDING_TTL_S = 600;

export const authorize = new Hono<AppEnv>();

// the session only: a bearer token on /authorize is nobody
authorize.use('/authorize', principalResolver());

const braked: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!(await oauthAllowed(c)))
    return page(429, consentErrorPage(locale(c), 'too many tries, wait a minute.'));
  await next();
};
authorize.use('/authorize', braked);

const locale = (c: Ctx) => localeFromAcceptLanguage(c.req.header('accept-language'));

async function page(status: 200 | 400 | 401 | 403 | 429, html: string, headers?: Headers) {
  const res = new Response(html, { status, headers });
  res.headers.set('content-type', 'text/html; charset=utf-8');
  res.headers.set('cache-control', 'no-store');
  res.headers.set('content-security-policy', await consentCsp());
  return res;
}

/** The signed-in person (by session cookie), or null. */
function person(c: Ctx) {
  const p = c.var.principal;
  return p.kind === 'user' ? { userId: p.userId, account: c.var.account } : null;
}

/** AuthorizationError / CimdFetchError -> a redirect to the client (if safe) or our page. */
async function authError(c: Ctx, e: unknown): Promise<Response> {
  if (e instanceof AuthorizationError && e.redirectTo) return c.redirect(e.redirectTo, 302);
  if (e instanceof AuthorizationError)
    return page(400, consentErrorPage(locale(c), e.description || e.code));
  if (e instanceof CimdFetchError)
    return page(400, consentErrorPage(locale(c), "that app's details couldn't be checked."));
  throw e;
}

authorize.get('/authorize', async (c) => {
  const oauth = authServer(agentOrigin(c)).getOAuthApi(c.env);
  let request: AuthRequest;
  try {
    request = await oauth.parseAuthRequest(c.req.raw);
  } catch (e) {
    return authError(c, e);
  }
  const me = person(c);
  if (!me) {
    // sign in first; the request waits in a sealed cookie (see the header comment)
    const query = new URL(c.req.url).search;
    setCookie(c, PENDING_COOKIE, await sealValue(query, c.env.SESSION_HMAC_KEY, PENDING_INFO), {
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
      maxAge: PENDING_TTL_S,
    });
    return c.redirect(`/auth/apple/start?returnTo=${encodeURIComponent('/oauth/resume')}`, 302);
  }
  let details;
  try {
    // first: a failed lookup leaves nothing in KV
    details = await oauth.describeConsent(request);
  } catch (e) {
    return authError(c, e);
  }
  const consent = await oauth.beginConsent(request);
  const html = consentPage(locale(c), {
    details,
    handle: consent.handle,
    signedInAs: me.account ? `${me.account.avatarEmoji} ${me.account.displayName}` : '',
    // a client that names no scopes gets asked for both (MCP clients send the resource's)
    requested: request.scope.length ? request.scope : ['spots:read', 'spots:write'],
  });
  const res = await page(200, html, consent.headers);
  res.headers.set('content-security-policy', await consentCsp(formTargets(details.redirectUri)));
  return res;
});

/** The redirect URI's origin, for form-action (only http(s); anything else is refused anyway). */
function formTargets(redirectUri: string): string[] {
  try {
    const u = new URL(redirectUri);
    return u.protocol === 'https:' || u.protocol === 'http:' ? [u.origin] : [];
  } catch {
    return [];
  }
}

/** The form came from our own page (the library's binding cookie checks the rest). */
function sameOrigin(c: Ctx): boolean {
  const site = c.req.header('sec-fetch-site');
  if (site !== undefined) return site === 'same-origin';
  const origin = c.req.header('origin');
  return origin === undefined || origin === new URL(c.req.url).origin;
}

authorize.post('/authorize', async (c) => {
  const me = person(c);
  if (!me) return page(401, consentErrorPage(locale(c), 'you were signed out.'));
  if (!sameOrigin(c)) return page(403, consentErrorPage(locale(c), 'refused (cross-site).'));
  const form = await c.req.formData();
  const raw = form.get('handle');
  const handle = typeof raw === 'string' ? raw : '';
  const oauth = authServer(agentOrigin(c)).getOAuthApi(c.env);
  try {
    if (form.get('decision') !== 'approve') {
      const denied = await oauth.denyConsent(c.req.raw, handle);
      return new Response(null, { status: 302, headers: denied.headers });
    }
    const pending = await oauth.approveConsent(c.req.raw, handle);
    // reading always; writing if ticked; offline_access if the client asked
    const ticked = form.getAll('scope').map(String);
    const scope = GRANTABLE_SCOPES.filter(
      (s) =>
        s === 'spots:read' ||
        (s === 'spots:write' && ticked.includes(s)) ||
        (s === 'offline_access' && pending.request.scope.includes(s)),
    );
    const details = await oauth.describeConsent(pending.request);
    const clientName = agentName(details.clientName);
    const metadata: GrantMetadata = {
      clientName,
      ...(details.clientDomain ? { clientDomain: details.clientDomain } : {}),
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: { ...pending.request, scope },
      userId: me.userId,
      metadata,
      scope,
      props: { userId: me.userId, clientName },
    });
    pending.headers.set('Location', redirectTo);
    return new Response(null, { status: 302, headers: pending.headers });
  } catch (e) {
    return authError(c, e);
  }
});

/** Back from Sign in with Apple: on to the consent page with the waiting request. */
authorize.get('/oauth/resume', async (c) => {
  const sealed = getCookie(c, PENDING_COOKIE);
  deleteCookie(c, PENDING_COOKIE, { path: '/', secure: true });
  const query = sealed ? await openValue(sealed, c.env.SESSION_HMAC_KEY, PENDING_INFO) : null;
  if (!query?.startsWith('?'))
    return page(400, consentErrorPage(locale(c), 'the connection request expired.'));
  return c.redirect(`/authorize${query}`, 302);
});
