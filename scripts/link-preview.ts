/**
 * Link-preview checks shared by the unit test (index.html + public/) and the
 * e2e test (what the built site serves without a session).
 */

/** `<meta property|name="..." content="...">` from static HTML, keyed by property/name. */
export function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const key = /\b(?:property|name)\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    const content = /\bcontent\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
    if (key && content !== undefined && !out.has(key)) out.set(key, content);
  }
  return out;
}

/** Every `<link rel="{rel}" href>` href in static HTML, in order. */
export function linkHrefs(html: string, rel: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    if (/\brel\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] !== rel) continue;
    const href = /\bhref\s*=\s*"([^"]+)"/i.exec(attrs)?.[1];
    if (href) out.push(href);
  }
  return out;
}

/** Width and height from a PNG's IHDR chunk; throws if it isn't a PNG. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 24 || signature.some((b, i) => bytes[i] !== b)) throw new Error('not a PNG');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Tags a rich preview needs (iMessage reads og:title/og:image; Slack/X the rest). */
export const REQUIRED_META = [
  'description',
  'theme-color',
  'og:type',
  'og:site_name',
  'og:title',
  'og:description',
  'og:url',
  'og:image',
  'og:image:width',
  'og:image:height',
  'og:image:alt',
  'twitter:card',
  'twitter:image',
] as const;

export const PUBLIC_ORIGIN = 'https://grub.shuaiyuan.me';
