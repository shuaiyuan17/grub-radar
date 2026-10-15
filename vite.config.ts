import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { headersFile } from './scripts/security-headers.ts';
import { bootLangScript } from './src/i18n/boot.ts';

/** Sets <html lang> from the saved/browser language before first paint. */
function bootLang(): Plugin {
  return {
    name: 'grub-radar:boot-lang',
    transformIndexHtml: () => [{ tag: 'script', children: bootLangScript(), injectTo: 'head' }],
  };
}

/**
 * Writes dist/client/_headers (CSP + friends) from the built index.html, so
 * static files get security headers too and the inline script hash is exact.
 */
function securityHeaders(): Plugin {
  return {
    name: 'grub-radar:security-headers',
    apply: 'build',
    writeBundle(options) {
      if (this.environment.name !== 'client' || !options.dir) return;
      const html = readFileSync(join(options.dir, 'index.html'), 'utf8');
      writeFileSync(join(options.dir, '_headers'), headersFile(html));
    },
  };
}

// `vite dev` / `vite preview` run the SPA and the Worker (worker/index.ts,
// local D1, .dev.vars) together, with wrangler.jsonc's asset routing.
// Tests live in vitest.config.ts.
export default defineConfig({
  plugins: [react(), bootLang(), securityHeaders(), cloudflare()],
  build: {
    // keep fonts as files: the CSP allows font-src 'self' only, no data: URIs
    assetsInlineLimit: (file) => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined),
  },
});
