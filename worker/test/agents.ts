/**
 * Test doubles for the agent door: an OAuth client that registers, sends a
 * person through the consent page and swaps the code for tokens, the way an
 * MCP client would; and the official MCP SDK client wired to the Worker.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { exports } from 'cloudflare:workers';
import { base64url, randomToken } from '../lib/crypto';
import { call, ORIGIN } from './helpers';

export const REDIRECT = 'http://127.0.0.1:43117/callback';

/** fetch, routed to the Worker (what an MCP client's network would be). */
export const workerFetch = (input: string | URL | Request, init?: RequestInit) =>
  exports.default.fetch(new Request(input, init));

export async function pkce() {
  const verifier = randomToken(32);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return { verifier, challenge: base64url(new Uint8Array(digest)) };
}

/** Dynamic client registration, as a public (PKCE) client. */
export async function registerClient(name = 'Test Agent', redirect = REDIRECT) {
  const res = await call('/oauth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  if (res.status !== 201) throw new Error(`register: ${res.status} ${await res.text()}`);
  return (await res.json<{ client_id: string }>()).client_id;
}

export interface AuthorizeOptions {
  scope?: string;
  resource?: string;
  redirect?: string;
}

export function authorizeUrl(clientId: string, challenge: string, o: AuthorizeOptions = {}) {
  const u = new URL('/authorize', ORIGIN);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', o.redirect ?? REDIRECT);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', 'st-123');
  u.searchParams.set('scope', o.scope ?? 'spots:read spots:write');
  u.searchParams.set('resource', o.resource ?? `${ORIGIN}/mcp`);
  return u;
}

/** All Set-Cookie name=value pairs, joined for a Cookie header (plus `base`). */
export function cookiesFrom(res: Response, base = ''): string {
  const pairs = res.headers.getSetCookie().map((l) => l.split(';')[0] ?? '');
  return [base, ...pairs].filter(Boolean).join('; ');
}

/** The consent page for `url`, as a signed-in person's browser sees it. */
export async function openConsent(url: URL, session: string) {
  const res = await call(`${url.pathname}${url.search}`, { cookie: session });
  const html = await res.clone().text();
  const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1] ?? null;
  return { res, html, handle, cookie: cookiesFrom(res, session) };
}

/** The person presses allow (with "add and edit" ticked unless `write: false`) or not now. */
export function answerConsent(
  handle: string,
  cookie: string,
  { approve = true, write = true }: { approve?: boolean; write?: boolean } = {},
) {
  const form = new URLSearchParams({ handle, decision: approve ? 'approve' : 'deny' });
  if (write) form.append('scope', 'spots:write');
  return call('/authorize', {
    method: 'POST',
    cookie,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'sec-fetch-site': 'same-origin',
      origin: ORIGIN,
    },
    body: form.toString(),
  });
}

export async function exchangeCode(
  clientId: string,
  code: string,
  verifier: string,
  redirect = REDIRECT,
) {
  return call('/oauth/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      code_verifier: verifier,
    }).toString(),
  });
}

export interface Tokens {
  access_token: string;
  refresh_token?: string;
  scope?: string;
  expires_in: number;
}

/** The whole dance for `session`'s person: register, consent, code, tokens. */
export async function connectAgent(
  session: string,
  o: AuthorizeOptions & { name?: string; write?: boolean } = {},
): Promise<Tokens & { clientId: string }> {
  const clientId = await registerClient(o.name);
  const { verifier, challenge } = await pkce();
  const page = await openConsent(authorizeUrl(clientId, challenge, o), session);
  if (!page.handle) throw new Error(`no consent page: ${page.res.status} ${page.html}`);
  const answer = await answerConsent(page.handle, page.cookie, { write: o.write ?? true });
  const code = new URL(answer.headers.get('location') ?? 'about:blank').searchParams.get('code');
  if (!code) throw new Error(`no code: ${answer.status} ${answer.headers.get('location')}`);
  const res = await exchangeCode(clientId, code, verifier, o.redirect);
  if (res.status !== 200) throw new Error(`token: ${res.status} ${await res.text()}`);
  return { ...(await res.json<Tokens>()), clientId };
}

/** The official MCP SDK client, connected to /mcp with a bearer token. */
export async function mcpClient(token: string): Promise<Client> {
  const client = new Client({ name: 'grub-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', ORIGIN), {
    authProvider: { token: () => Promise.resolve(token) },
    fetch: workerFetch,
  });
  await client.connect(transport);
  return client;
}

/** A tool's JSON answer (every tool answers with one JSON text block). */
export function toolJson(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  const block = content.find((c) => c.type === 'text');
  return JSON.parse(block?.text ?? 'null') as Record<string, unknown>;
}
