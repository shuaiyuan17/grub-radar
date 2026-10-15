import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        // React components and app glue, in jsdom
        plugins: [react()],
        test: {
          name: 'spa',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['src/domain/**', 'src/contracts/**'],
          css: false,
        },
      },
      {
        // framework-free logic shared by the SPA and the Worker
        test: {
          name: 'domain',
          environment: 'node',
          globals: true,
          include: [
            'src/domain/**/*.test.ts',
            'src/contracts/**/*.test.ts',
            'scripts/**/*.test.ts',
          ],
        },
      },
      {
        // the Worker, inside workerd (Miniflare) with a local D1
        plugins: [
          cloudflareTest(async () => ({
            wrangler: { configPath: './wrangler.jsonc' },
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations('./migrations'),
                // tests never see .dev.vars or real keys
                // 'development' turns on dev login + request-origin redirects; tests override per case
                ENVIRONMENT: 'development',
                SESSION_HMAC_KEY: 'test-hmac-key-test-hmac-key-0123',
                DEV_LOGIN_SECRET: 'test-dev-login-secret',
                SIGNUP_OPEN: 'false',
                APPLE_ENDPOINT_BASE: '',
                APPLE_MAPS_BASE: '',
                APPLE_PRIVATE_KEY: generateKeyPairSync('ec', { namedCurve: 'P-256' })
                  .privateKey.export({ type: 'pkcs8', format: 'pem' })
                  .toString(),
              },
            },
          })),
        ],
        test: {
          name: 'worker',
          // workerd can't read Vitest 5's on-disk module cache
          fsModuleCache: false,
          include: ['worker/**/*.test.ts'],
          setupFiles: ['./worker/test/apply-migrations.ts'],
        },
      },
    ],
  },
});
