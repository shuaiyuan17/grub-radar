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
 * Default: the shared dev user with the fictional demo spots on its list
 * (dev-only POST /api/spots/import-demo; idempotent). Tests that write pass
 * `as` for a user of their own, and `demo: false` to start empty like a real
 * new account.
 */
export async function devLogin(page: Page, opts: { as?: string; demo?: boolean } = {}) {
  await page.goto('/favicon.svg');
  const status = await page.evaluate(
    async ({ secret, as, demo }) => {
      const headers = {
        'content-type': 'application/json',
        'x-grub-request': '1',
        'x-dev-login-secret': secret,
      };
      const res = await fetch('/auth/dev-login', {
        method: 'POST',
        headers,
        body: JSON.stringify(as ? { as } : {}),
      });
      if (res.status !== 204 || !demo) return res.status;
      const imported = await fetch('/api/spots/import-demo', {
        method: 'POST',
        headers,
        body: '{}',
      });
      return imported.ok ? 204 : imported.status;
    },
    { secret: devVar('DEV_LOGIN_SECRET'), as: opts.as, demo: opts.demo ?? true },
  );
  expect(status).toBe(204);
}
