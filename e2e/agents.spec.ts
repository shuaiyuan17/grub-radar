import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { devLogin, freshUser } from './session';

// The agent door in a real browser: the settings page (connect prompt,
// personal tokens, connected agents), the consent page (signed out → Sign in
// with Apple stub → consent), and a spot added by an agent on its card.
//
// SHOTS_DIR=/some/dir saves screenshots along the way (not in CI).

const SHOTS = process.env.SHOTS_DIR;
const REDIRECT = 'http://127.0.0.1:43117/callback';

/**
 * A stand-in for the agent's own loopback listener (where the browser lands
 * after "allow"): records the callback URL and says "back in your agent".
 */
async function loopback(): Promise<{ redirect: string; hits: URL[]; server: Server }> {
  const hits: URL[] = [];
  const server = createServer((req, res) => {
    hits.push(new URL(req.url ?? '/', 'http://127.0.0.1'));
    res.writeHead(200, { 'content-type': 'text/plain' }).end('back in your agent');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return { redirect: `http://127.0.0.1:${String(port)}/callback`, hits, server };
}

async function settle(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').length),
    )
    .toBe(0);
}

async function shot(page: Page, name: string, project: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await settle(page);
  await page.screenshot({ path: `${SHOTS}/${project}-${name}.png`, fullPage: true });
}

async function noSeriousA11yIssues(page: Page) {
  await settle(page);
  const { violations } = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const serious = violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`),
  ).toEqual([]);
}

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** DCR + a PKCE pair + the /authorize URL an MCP client would open. */
async function newClient(request: APIRequestContext, name: string, redirect = REDIRECT) {
  const reg = await request.post('/oauth/register', {
    data: {
      client_name: name,
      redirect_uris: [redirect],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
  });
  expect(reg.status()).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const q = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: redirect,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'e2e',
    scope: 'spots:read spots:write',
  });
  return { clientId: client_id, verifier, url: `/authorize?${q.toString()}` };
}

test('settings: copy the prompt, make a token, an agent adds a spot, the card says who', async ({
  page,
  context,
  request,
}, info) => {
  await devLogin(page, { as: freshUser('agents'), demo: false });
  await page.goto('/settings');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('agents');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await page.getByRole('button', { name: 'copy for your agent' }).click();
  await expect(page.getByText(/copied\. paste it to your agent\.|couldn't copy/)).toBeVisible();
  await expect(
    page.getByText(/agent-setup\.md and connect yourself to my grub radar\./),
  ).toBeVisible();

  const tokens = page.getByRole('region', { name: 'personal tokens' });
  await tokens.getByLabel(/name it/).fill('grok bot');
  await tokens.getByRole('button', { name: 'make a token' }).click();
  const secretField = tokens.getByLabel(/copy it now/);
  await expect(secretField).toHaveValue(/^grub_pat_/);
  const secret = await secretField.inputValue();
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
  await shot(page, 'settings-token', info.project.name);

  // the "agent": REST with the token (no cookie, no CSRF header)
  const add = await request.post('/api/spots', {
    headers: { authorization: `Bearer ${secret}` },
    data: { name: 'Lantern Dumplings', kind: 'food', location: { lat: 47.611, lng: -122.334 } },
  });
  expect(add.status()).toBe(201);
  // but not the person's own things
  expect(
    (await request.get('/api/me', { headers: { authorization: `Bearer ${secret}` } })).status(),
  ).toBe(403);

  await page.goto('/');
  const card = page.getByRole('article').filter({ hasText: 'Lantern Dumplings' });
  await expect(card.getByText('grok bot')).toBeVisible();
  await expect(card).toContainText('found by');
  await shot(page, 'card-found-by', info.project.name);

  // the token shows as used; revoking it shuts the agent out
  await page.goto('/settings');
  await expect(tokens.getByText(/last used/)).toBeVisible();
  await tokens.getByRole('button', { name: 'revoke grok bot' }).click();
  await expect(tokens.getByText('no tokens.')).toBeVisible();
  expect(
    (await request.get('/api/spots', { headers: { authorization: `Bearer ${secret}` } })).status(),
  ).toBe(401);
});

test('OAuth: signed out → Sign in with Apple → consent → allow → token → MCP → disconnect', async ({
  page,
  request,
}, info) => {
  const agent = await loopback();
  const client = await newClient(request, 'Claude Code', agent.redirect);
  const violations: string[] = [];
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) violations.push(m.text());
  });

  // signed out: the consent request waits while the person signs in at "Apple"
  await page.goto(client.url);
  await expect(page).toHaveURL(/localhost:4599\/auth\/authorize/);
  await page.getByLabel('Apple ID').fill(freshUser('oauth'));
  await page.getByRole('button', { name: 'Continue' }).click();
  // a first sign-in without Apple's name; the consent page doesn't need one
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Claude Code', {
    timeout: 15_000,
  });
  await expect(page).toHaveURL(/\/authorize\?/);
  await expect(page.getByText('127.0.0.1')).toBeVisible();
  await expect(page.getByText('see your spots and notes')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /add spots/ })).toBeChecked();
  await noHorizontalScroll(page);
  await noSeriousA11yIssues(page);
  await shot(page, 'consent', info.project.name);

  // allow: the browser goes back to the agent's loopback listener with a code
  await page.getByRole('button', { name: 'allow' }).click();
  await expect(page.getByText('back in your agent')).toBeVisible();
  agent.server.close();
  const code = agent.hits[0]?.searchParams.get('code');
  expect(code).toBeTruthy();
  expect(violations).toEqual([]);

  const tokenRes = await request.post('/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: agent.redirect,
      client_id: client.clientId,
      code_verifier: client.verifier,
    },
  });
  expect(tokenRes.status()).toBe(200);
  const { access_token } = (await tokenRes.json()) as { access_token: string };

  const rpc = (body: unknown) =>
    request.post('/mcp', {
      headers: {
        authorization: `Bearer ${access_token}`,
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-06-18',
      },
      data: body,
    });
  const init = await rpc({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  });
  expect(init.status()).toBe(200);
  expect(await init.text()).toContain('grub-radar');

  // the person's settings list the agent; disconnecting kills the token
  await page.goto('/settings');
  const agents = page.getByRole('region', { name: 'connected agents' });
  await expect(agents.getByText('Claude Code')).toBeVisible();
  await shot(page, 'settings-connected', info.project.name);
  await agents.getByRole('button', { name: 'disconnect Claude Code' }).click();
  await expect(agents.getByText('no agents connected yet.')).toBeVisible();
  expect((await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).status()).toBe(401);
});

test('the consent page in Chinese', async ({ browser, request }, info) => {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: info.project.use.viewport ?? undefined,
  });
  const page = await context.newPage();
  await devLogin(page, { as: freshUser('zh-oauth'), demo: false });
  const client = await newClient(request, 'Codex');
  await page.goto(client.url);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('使用你的 grub radar');
  await expect(page.getByRole('button', { name: '允许' })).toBeVisible();
  await shot(page, 'consent-zh', info.project.name);
  await context.close();
});

test('docs for agents are served', async ({ request }) => {
  const setup = await request.get('/agent-setup.md');
  expect(setup.status()).toBe(200);
  expect(await setup.text()).toContain('/mcp');
  expect((await request.get('/llms.txt')).status()).toBe(200);
  const api = (await (await request.get('/openapi.json')).json()) as { paths: object };
  expect(Object.keys(api.paths)).toContain('/api/spots');
});
