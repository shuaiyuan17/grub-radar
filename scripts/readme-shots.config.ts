import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import base from '../playwright.config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));

// The README screenshots: `npx playwright test -c scripts/readme-shots.config.ts`.
// Same servers as e2e (Apple stub + preview, fictional demo data only), phone size,
// one spec outside e2e/ so CI never runs it. Writes test-results/readme-screens.png; then
// `cwebp -q 82 test-results/readme-screens.png -o docs/images/screens.webp` (keep it < 400 KB).
export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: 'readme-shots.spec.ts',
  fullyParallel: false,
  retries: 0,
  projects: base.projects?.filter((p) => p.name === 'phone'),
  // webServer commands run from the config's folder by default
  webServer: [base.webServer ?? []].flat().map((s) => ({ ...s, cwd: root })),
});
