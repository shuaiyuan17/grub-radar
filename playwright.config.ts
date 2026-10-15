import { defineConfig, devices } from '@playwright/test';

// overridable so two checkouts can run e2e side by side (point .dev.vars' Apple bases at the stub port)
const PORT = Number(process.env.E2E_PORT ?? 4173);
const STUB_PORT = Number(process.env.APPLE_STUB_PORT ?? 4599);

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'phone',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } },
    },
    {
      // Safari's engine on an iPhone: some layout bugs (an <input>'s intrinsic width in a
      // flex box) only show in WebKit. Layout spec only, to keep CI quick.
      name: 'webkit-phone',
      testMatch: 'layout.spec.ts',
      use: { ...devices['iPhone 17 Pro'] },
    },
  ],
  webServer: [
    {
      // stands in for appleid.apple.com (.dev.vars points the Worker here)
      command: 'node e2e/apple-stub.ts',
      url: `http://localhost:${STUB_PORT}/health`,
      reuseExistingServer: !process.env.CI,
    },
    {
      // The SPA + Worker in workerd with a local D1 (vite preview + Cloudflare plugin).
      // CI builds once in its own step; locally, build first so tests see current code.
      command: process.env.CI
        ? `npm run db:migrate:local && npm run preview -- --port ${PORT} --strictPort`
        : `npm run build && npm run db:migrate:local && npm run preview -- --port ${PORT} --strictPort`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
