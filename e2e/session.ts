import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** A value from .dev.vars (written by `npm run dev:vars`). */
export function devVar(name: string): string {
  const file = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .dev.vars`);
  return line.slice(name.length + 1).replace(/^"|"$/g, '');
}

/** A dev-user label nobody else uses (tests run in parallel against one local D1). */
export const freshUser = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

/**
 * Signs the browser in via POST /auth/dev-login (local only), from a
 * same-origin page so the browser stores the cookie itself. (A static file:
 * API responses carry `default-src 'none'`, which blocks fetch.)
 *
 * WebKit won't store a `Secure` cookie from http://localhost, so there the
 * login goes through the test's request context and the session cookie is
 * handed to the browser directly.
 *
 * Default: the shared dev user with the fictional demo spots on its list
 * (dev-only POST /api/spots/import-demo; idempotent). Tests that write pass
 * `as` for a user of their own, and `demo: false` to start empty like a real
 * new account.
 */
export async function devLogin(page: Page, opts: { as?: string; demo?: boolean } = {}) {
  const secret = devVar('DEV_LOGIN_SECRET');
  const webkit = page.context().browser()?.browserType().name() === 'webkit';
  if (webkit) await webkitLogin(page, secret, opts.as);
  await page.goto('/favicon.svg');
  const status = await page.evaluate(
    async ({ secret, as, demo, login }) => {
      const headers = {
        'content-type': 'application/json',
        'x-grub-request': '1',
        'x-dev-login-secret': secret,
      };
      if (login) {
        const res = await fetch('/auth/dev-login', {
          method: 'POST',
          headers,
          body: JSON.stringify(as ? { as } : {}),
        });
        if (res.status !== 204) return res.status;
      }
      if (!demo) return 204;
      const imported = await fetch('/api/spots/import-demo', {
        method: 'POST',
        headers,
        body: '{}',
      });
      return imported.ok ? 204 : imported.status;
    },
    { secret, as: opts.as, demo: opts.demo ?? true, login: !webkit },
  );
  expect(status).toBe(204);
}

/** dev-login from the request context, then the session cookie into the browser (WebKit). */
async function webkitLogin(page: Page, secret: string, as: string | undefined) {
  await page.goto('/favicon.svg');
  const base = new URL('/', page.url());
  const res = await page.request.post(new URL('/auth/dev-login', base).href, {
    headers: {
      'content-type': 'application/json',
      'x-grub-request': '1',
      'x-dev-login-secret': secret,
      origin: base.origin,
    },
    data: as ? { as } : {},
  });
  expect(res.status()).toBe(204);
  const token = /__Host-grub_session=([^;]+)/.exec(res.headers()['set-cookie'] ?? '')?.[1];
  expect(token, 'session cookie').toBeTruthy();
  await page.context().addCookies([
    {
      name: '__Host-grub_session',
      value: token ?? '',
      url: base.href,
      secure: true,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
}
