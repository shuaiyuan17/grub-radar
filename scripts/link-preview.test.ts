import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { linkHrefs, metaTags, pngSize, PUBLIC_ORIGIN, REQUIRED_META } from './link-preview';

const root = new URL('../', import.meta.url);
// Vite copies <head> through to dist/client/index.html as is (it only adds
// script/style tags); e2e/link-preview.spec.ts checks the served build too.
const html = readFileSync(new URL('index.html', root), 'utf8');
const meta = metaTags(html);
const publicFile = (path: string) => readFileSync(new URL(`public${path}`, root));

describe('link preview', () => {
  it('has every tag a rich preview needs, in the static HTML', () => {
    for (const key of REQUIRED_META) expect(meta.get(key), key).toBeTruthy();
    expect(meta.get('og:title')).toBe('grub radar');
    expect(meta.get('og:type')).toBe('website');
    expect(meta.get('twitter:card')).toBe('summary_large_image');
    expect(meta.get('og:url')).toBe(`${PUBLIC_ORIGIN}/`);
  });

  it('points og:image at an absolute https URL of a 1200×630 PNG under 300 KB', () => {
    const image = new URL(meta.get('og:image') ?? '');
    expect(image.origin).toBe(PUBLIC_ORIGIN);
    expect(meta.get('twitter:image')).toBe(image.href);
    const png = publicFile(image.pathname);
    const size = pngSize(png);
    expect(size).toEqual({ width: 1200, height: 630 });
    expect(String(size.width)).toBe(meta.get('og:image:width'));
    expect(String(size.height)).toBe(meta.get('og:image:height'));
    expect(png.length).toBeLessThan(300 * 1024);
  });

  it('has a 180×180 apple-touch-icon and a PNG favicon', () => {
    const [touch] = linkHrefs(html, 'apple-touch-icon');
    expect(touch).toBe('/apple-touch-icon.png');
    expect(pngSize(publicFile('/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
    const icons = linkHrefs(html, 'icon');
    expect(icons).toContain('/favicon.svg');
    const png = icons.find((href) => href.endsWith('.png'));
    expect(png).toBeTruthy();
    expect(pngSize(publicFile(png ?? ''))).toEqual({ width: 32, height: 32 });
  });

  it('reads PNG sizes and rejects other files', () => {
    expect(() => pngSize(new Uint8Array(30))).toThrow('not a PNG');
  });
});
