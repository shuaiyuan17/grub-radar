import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Everything the browser adds on top of plain JavaScript (window, document,
// location, fetch, localStorage, ...) plus globalThis: off limits in src/domain.
const browserOnlyGlobals = [
  ...Object.keys(globals.browser).filter((name) => !(name in globals.builtin)),
  'globalThis',
];

export default defineConfig([
  globalIgnores([
    'dist',
    'dist-worker',
    'coverage',
    'playwright-report',
    'test-results',
    '.wrangler',
  ]),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.strictTypeChecked,
      tseslint.configs.stylisticTypeChecked,
      reactHooks.configs.flat['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
    },
  },
  {
    // The demo seed never ships in the app bundle (the login wall means nothing is
    // public): app code reads spots through the SpotRepository it is given.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/data/**', 'src/domain/**', '**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/data/seed', '**/data/staticRepository'],
              message: 'Use the SpotRepository from context (useSpotSource) instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // The Worker: runs in workerd, shares only the domain and the wire contracts.
    files: ['worker/**/*.ts'],
    languageOptions: { globals: globals.worker },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*', 'react/*'], message: 'The Worker must not use React.' },
            {
              group: [
                '**/src/*',
                '!**/src/domain',
                '!**/src/contracts',
                // PR 1 only: the demo spots behind GET /api/spots; PR 2 moves spots to D1
                '!**/src/data',
                '**/src/data/*',
                '!**/src/data/seed',
              ],
              message: 'worker/ may import only src/domain and src/contracts.',
            },
          ],
        },
      ],
    },
  },
  {
    // Wire schemas shared by the SPA and the Worker: zod + the domain, nothing else.
    files: ['src/contracts/**/*.ts'],
    ignores: ['**/*.test.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['react', 'react-*', 'react/*'],
              message: 'src/contracts must not use React.',
            },
            {
              group: ['**/lib/**', '**/components/**', '**/pages/**', '**/data/**', '**/config'],
              message: 'src/contracts may import only src/domain and zod.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...browserOnlyGlobals.map((name) => ({
          name,
          message: 'src/contracts is shared with the Worker: no browser globals.',
        })),
      ],
    },
  },
  {
    // The domain is framework-free so it can move behind an API / MCP server.
    files: ['src/domain/**/*.{ts,tsx}'],
    ignores: ['**/*.test.{ts,tsx}'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['react', 'react-*', 'react/*'], message: 'src/domain must not use React.' },
            {
              group: [
                '**/lib/**',
                '**/components/**',
                '**/pages/**',
                '**/data/**',
                '**/config',
                '**/config.ts',
                '**/config.js',
              ],
              message: 'src/domain must not depend on the app or the data source.',
            },
          ],
        },
      ],
      'no-restricted-globals': [
        'error',
        ...browserOnlyGlobals.map((name) => ({
          name,
          message: 'src/domain is framework-free: no browser globals.',
        })),
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', 'src/test/**', 'worker/test/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['*.js', 'scripts/dev-vars.mjs'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  prettier,
]);
