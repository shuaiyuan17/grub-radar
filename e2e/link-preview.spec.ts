import { expect, test } from '@playwright/test';
import { metaTags, pngSize, PUBLIC_ORIGIN, REQUIRED_META } from '../scripts/link-preview';

// Link-preview crawlers (iMessage's LinkPresentation, Slack, X) have no session
// and run no JS: the built HTML and the images must be there for them as is.
// The `request` fixture carries no cookies, so this is exactly what they see.
const CRAWLER_UA = 'Mozilla/5.0 (compatible; facebookexternalhit/1.1; Twitterbot/1.0)';

test('a crawler without a session gets the preview tags in the static HTML', async ({
  request,
}) => {
  const res = await request.get('/', { headers: { 'user-agent': CRAWLER_UA } });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/html');
  const meta = metaTags(await res.text());
  for (const key of REQUIRED_META) expect(meta.get(key), key).toBeTruthy();
  const image = new URL(meta.get('og:image') ?? '');
  expect(image.protocol).toBe('https:');
  expect(image.origin).toBe(PUBLIC_ORIGIN);

  const png = await request.get(image.pathname, { headers: { 'user-agent': CRAWLER_UA } });
  expect(png.status()).toBe(200);
  expect(png.headers()['content-type']).toBe('image/png');
  expect(pngSize(await png.body())).toEqual({
    width: Number(meta.get('og:image:width')),
    height: Number(meta.get('og:image:height')),
  });
});

for (const [path, size] of [
  ['/og.png', 1200],
  ['/apple-touch-icon.png', 180],
  ['/favicon-32.png', 32],
] as const) {
  test(`${path} is a PNG anyone can fetch, no session`, async ({ request }) => {
    const res = await request.get(path);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toBe('image/png');
    expect(pngSize(await res.body()).width).toBe(size);
  });
}
