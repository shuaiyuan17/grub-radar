/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { bootLangScript } from './src/i18n/boot';

/** Sets <html lang> from the saved/browser language before first paint. */
function bootLang(): Plugin {
  return {
    name: 'grub-radar:boot-lang',
    transformIndexHtml: () => [
      { tag: 'script', children: bootLangScript(), injectTo: 'head' },
    ],
  };
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), bootLang()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
