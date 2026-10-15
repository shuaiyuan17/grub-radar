// Measures the Chinese font bytes a first zh visit downloads.
//   npm run build && npm run preview -- --port 4173   (another shell)
//   node scripts/zh-fonts.mjs [url]
import { chromium } from '@playwright/test';

const base = process.argv[2] ?? 'http://localhost:4173';
const viewports = { phone: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } };
const browser = await chromium.launch();

for (const [name, viewport] of Object.entries(viewports)) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => localStorage.setItem('grub-radar:lang', 'zh-Hans'));
  const page = await context.newPage();
  const files = new Map();
  page.on('response', async (res) => {
    const m = /(zcool-kuaile|long-cang)-[\w-]+\.woff2/.exec(res.url());
    if (!m) return;
    const body = await res.body().catch(() => Buffer.alloc(0));
    // count each slice once (a revisit may come from cache)
    const prev = files.get(m[0])?.bytes ?? 0;
    files.set(m[0], { family: m[1], bytes: Math.max(prev, body.length) });
  });
  const visit = async (path) => {
    await page.goto(base + path);
    await page.waitForLoadState('networkidle');
    await page.evaluate(() => document.fonts.ready);
  };
  const total = () => {
    const by = {};
    for (const f of files.values()) {
      by[f.family] ??= { files: 0, kB: 0 };
      by[f.family].files++;
      by[f.family].kB += f.bytes / 1024;
    }
    let sum = 0;
    for (const v of Object.values(by)) {
      sum += v.kB;
      v.kB = Math.round(v.kB * 10) / 10;
    }
    return { ...by, totalKB: Math.round(sum * 10) / 10 };
  };
  await visit('/');
  const list = total();
  await visit('/place/lucky-thread');
  await visit('/radar');
  console.log(JSON.stringify({ viewport: name, firstLoadList: list, afterPlaceAndRadar: total() }));
  await context.close();
}
await browser.close();
