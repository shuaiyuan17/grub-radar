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
  globalIgnores(['dist', 'coverage', 'playwright-report', 'test-results']),
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
    // Only the repository reads the seed file; everyone else goes through SpotRepository.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/data/**', 'src/domain/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ group: ['**/data/seed'], message: 'Use the SpotRepository instead.' }] },
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
    files: ['**/*.test.{ts,tsx}', 'src/test/**'],
    rules: {
      'react-refresh/only-export-components': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
  {
    files: ['*.js'],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  prettier,
]);
