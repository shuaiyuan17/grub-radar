import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { bootLangScript } from './src/i18n/boot.ts';

/** Sets <html lang> from the saved/browser language before first paint. */
function bootLang(): Plugin {
  return {
    name: 'grub-radar:boot-lang',
    transformIndexHtml: () => [{ tag: 'script', children: bootLangScript(), injectTo: 'head' }],
  };
}

// `vite dev` / `vite preview` run the SPA and the Worker (worker/index.ts,
// local D1, .dev.vars) together, with wrangler.jsonc's asset routing.
// Tests live in vitest.config.ts.
export default defineConfig({
  plugins: [react(), bootLang(), cloudflare()],
});
