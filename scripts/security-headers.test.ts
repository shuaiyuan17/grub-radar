import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentSecurityPolicy, headersFile, inlineScripts } from './security-headers';

const html = `<!doctype html><html><head>
<script>(function () { document.documentElement.lang = 'en'; })();</script>
<script type="module" crossorigin src="/assets/index-abc.js"></script>
</head><body></body></html>`;

describe('security headers', () => {
  it('finds inline scripts only', () => {
    expect(inlineScripts(html)).toEqual([
      "(function () { document.documentElement.lang = 'en'; })();",
    ]);
  });

  it('allows exactly those inline scripts by hash, never unsafe-inline', () => {
    const csp = contentSecurityPolicy(html);
    const hash = createHash('sha256')
      .update("(function () { document.documentElement.lang = 'en'; })();")
      .digest('base64');
    expect(csp).toContain(`script-src 'self' 'sha256-${hash}'`);
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });

  it('lets images come from this origin, data: and blob: (upload previews), nowhere else', () => {
    const csp = contentSecurityPolicy(html);
    expect(csp).toContain("img-src 'self' data: blob:;");
    // blob: is for images only: never for scripts, styles, frames or connections
    const directives = csp.split('; ');
    expect(directives.filter((d) => d.includes('blob:'))).toEqual(["img-src 'self' data: blob:"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it('applies to every path', () => {
    const file = headersFile(html);
    expect(file.split('\n')[0]).toBe('/*');
    for (const h of [
      'X-Content-Type-Options: nosniff',
      'Referrer-Policy: strict-origin-when-cross-origin',
      'Permissions-Policy: geolocation=(self)',
    ])
      expect(file).toContain(h);
  });
});
