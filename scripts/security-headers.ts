/**
 * Security headers for the static site (Workers Static Assets `_headers`).
 * Static files never run the Worker, so its header middleware can't reach
 * them; this file can. Generated at build time from the built index.html, so
 * the CSP hash of the inline language-boot script always matches.
 */
import { createHash } from 'node:crypto';

/** Contents of every inline (no src) <script> in the HTML. */
export function inlineScripts(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1] ?? '';
    if (/\bsrc\s*=/i.test(attrs)) continue;
    out.push(m[2] ?? '');
  }
  return out;
}

export const cspHash = (script: string) =>
  `'sha256-${createHash('sha256').update(script, 'utf8').digest('base64')}'`;

export function contentSecurityPolicy(html: string): string {
  const hashes = inlineScripts(html).map(cspHash);
  return [
    "default-src 'self'",
    `script-src 'self' ${hashes.join(' ')}`.trim(),
    // React sets style via the CSSOM, which CSP doesn't block; no inline <style>
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/** The `_headers` file: every path gets the same set. */
export function headersFile(html: string): string {
  return [
    '/*',
    `  Content-Security-Policy: ${contentSecurityPolicy(html)}`,
    '  X-Content-Type-Options: nosniff',
    '  X-Frame-Options: DENY',
    '  Referrer-Policy: strict-origin-when-cross-origin',
    '  Permissions-Policy: geolocation=(self), camera=(), microphone=()',
    '  Cross-Origin-Opener-Policy: same-origin',
    '  Strict-Transport-Security: max-age=31536000',
    '',
  ].join('\n');
}
