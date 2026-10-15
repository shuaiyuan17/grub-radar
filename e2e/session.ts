import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/** A value from .dev.vars (written by `npm run dev:vars`). */
export function devVar(name: string): string {
  const file = readFileSync(new URL('../.dev.vars', import.meta.url), 'utf8');
  const line = file.split('\n').find((l) => l.startsWith(`${name}=`));
  if (!line) throw new Error(`${name} missing from .dev.vars`);
  return line.slice(name.length + 1).replace(/^"|"$/g, '');
}

/**
 * Signs the browser in as the fixed dev user via POST /auth/dev-login (local
 * only), from a same-origin page so the browser stores the cookie itself.
 */
export async function devLogin(page: Page) {
  await page.goto('/api/health');
  const status = await page.evaluate(async (secret) => {
    const res = await fetch('/auth/dev-login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-grub-request': '1',
        'x-dev-login-secret': secret,
      },
      body: '{}',
    });
    return res.status;
  }, devVar('DEV_LOGIN_SECRET'));
  expect(status).toBe(204);
}
