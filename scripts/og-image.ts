// Draws the link-preview images in the app's own sketch-kit style and writes
// them to public/:
//   og.png                1200×630  Open Graph / Twitter card (iMessage, Slack, ...)
//   apple-touch-icon.png  180×180   home screen + iMessage's fallback icon
//   favicon-32.png        32×32     PNG favicon for browsers without SVG favicons
//
//   node scripts/og-image.ts            (needs `npx playwright install chromium`)
//
// Colours come from the tokens in src/styles/global.css, fonts from the same
// @fontsource packages the app ships, outlines from the app's own wobbly-path
// code. Commit the PNGs: they're static files, served without a session.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';
import { wobblyPath, type Corner, type Radii } from '../src/lib/inkPath.ts';
import { RING_DIAMETERS } from '../src/lib/radar.ts';
import { UI_ICONS } from '../src/components/icons.ts';

const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root));

/** The sketch kit's colour tokens (`--name: #hex;` in :root). */
function colourTokens(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/--([\w-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)) {
    const [, name, value] = m;
    if (name && value && !(name in out)) out[name] = value;
  }
  return out;
}

const tokens = colourTokens(read('src/styles/global.css').toString('utf8'));
const c = (name: string) => {
  const v = tokens[name];
  if (!v) throw new Error(`--${name} missing from global.css`);
  return v;
};
const paper = c('paper');
const card = c('card');
const ink = c('ink');
const pencil = c('pencil');
const hl = c('hl');
const tomato = c('tomato');
const dotGrid = c('dot-grid');

const font = (family: string, weight: number, file: string) =>
  `@font-face{font-family:'${family}';font-weight:${weight};font-style:normal;src:url(data:font/woff2;base64,${read(file).toString('base64')}) format('woff2')}`;
const fonts = [
  font(
    'Shantell Sans',
    800,
    'node_modules/@fontsource/shantell-sans/files/shantell-sans-latin-800-normal.woff2',
  ),
  font(
    'Shantell Sans',
    600,
    'node_modules/@fontsource/shantell-sans/files/shantell-sans-latin-600-normal.woff2',
  ),
  font('Caveat', 700, 'node_modules/@fontsource/caveat/files/caveat-latin-700-normal.woff2'),
].join('\n');

const RADAR_ICON = UI_ICONS.radar;
const HOME_ICON = UI_ICONS.home;

const round = (w: number, h: number): Radii => {
  const k: Corner = { x: w / 2, y: h / 2 };
  return [k, k, k, k];
};
/** --r-blob: 52% 48% 45% 55% / 55% 45% 55% 45% */
const blob = (w: number, h: number): Radii => [
  { x: 0.52 * w, y: 0.55 * h },
  { x: 0.48 * w, y: 0.45 * h },
  { x: 0.45 * w, y: 0.55 * h },
  { x: 0.55 * w, y: 0.45 * h },
];

/** A hand-drawn shape at (x, y), size w×h, like an `.sk` element's <Ink>. */
function sk(
  x: number,
  y: number,
  w: number,
  h: number,
  radii: Radii,
  opts: { seed: number; fill: string; bw: number; dash?: string; amp?: number; shadow?: boolean },
) {
  const d = wobblyPath(w, h, radii, opts.seed, opts.bw / 2, opts.amp);
  const shadow = opts.shadow ? `<path d="${d}" fill="${ink}" transform="translate(4 5)"/>` : '';
  const dash = opts.dash ? ` stroke-dasharray="${opts.dash}"` : '';
  return `<g transform="translate(${x} ${y})">${shadow}<path d="${d}" fill="${opts.fill}" stroke="${ink}" stroke-width="${opts.bw}" stroke-linejoin="round" stroke-linecap="round"${dash}/></g>`;
}

function icon(path: string, cx: number, cy: number, size: number, strokeWidth = 2) {
  const s = size / 24;
  return `<g transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${s})"><path d="${path}" fill="none" stroke="${ink}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></g>`;
}

/** Kind marks from Radar.module.css: food = round tomato, coffee = ink square, bakery = yellow diamond. */
function mark(kind: 'food' | 'coffee' | 'bakery', cx: number, cy: number, size = 26) {
  const half = size / 2;
  const stroke = `stroke="${ink}" stroke-width="3.5"`;
  if (kind === 'food')
    return `<ellipse cx="${cx}" cy="${cy}" rx="${half}" ry="${half * 0.94}" fill="${tomato}" ${stroke} transform="rotate(-12 ${cx} ${cy})"/>`;
  if (kind === 'coffee')
    return `<rect x="${cx - half}" y="${cy - half}" width="${size}" height="${size}" rx="5" fill="${ink}" ${stroke} transform="rotate(4 ${cx} ${cy})"/>`;
  const d = size * 0.88;
  return `<rect x="${cx - d / 2}" y="${cy - d / 2}" width="${d}" height="${d}" rx="3" fill="${hl}" ${stroke} transform="rotate(45 ${cx} ${cy})"/>`;
}

function radar(cx: number, cy: number, size: number) {
  const fills = [card, 'rgba(255,253,248,0.7)', 'rgba(255,253,248,0.55)', 'transparent'];
  const rings = [3, 2, 1, 0]
    .map((i) => {
      const d = (RING_DIAMETERS[i] ?? 1) * size;
      return sk(cx - d / 2, cy - d / 2, d, d, round(d, d), {
        seed: 11 + i * 7,
        fill: fills[i] ?? 'transparent',
        bw: 3,
        amp: 2,
        ...(i === 3 ? { dash: '11 9' } : {}),
      });
    })
    .join('');
  const labels = ['10 min', '30 min', '1 hr', 'road trip']
    .map((label, i) => {
      const y = cy - ((RING_DIAMETERS[i] ?? 1) / 2) * size;
      const bg = i < 2 ? card : paper;
      const w = label.length * 11 + 14;
      return `<rect x="${cx - w / 2}" y="${y - 14}" width="${w}" height="28" rx="8" fill="${bg}"/><text x="${cx}" y="${y + 8}" text-anchor="middle" font-family="Caveat" font-weight="700" font-size="24" fill="${ink}">${label}</text>`;
    })
    .join('');
  // a few spots: (angle in degrees clockwise from north, distance in diameter units)
  const spots: [kind: 'food' | 'coffee' | 'bakery', deg: number, r: number][] = [
    ['food', 62, 0.12],
    ['coffee', 205, 0.11],
    ['bakery', 118, 0.235],
    ['food', 300, 0.25],
    ['coffee', 30, 0.345],
    ['food', 168, 0.36],
    ['food', 238, 0.335],
    ['bakery', 335, 0.44],
    ['food', 95, 0.455],
  ];
  const dots = spots
    .map(([kind, deg, r]) => {
      const a = (deg * Math.PI) / 180;
      return mark(kind, cx + Math.sin(a) * r * size, cy - Math.cos(a) * r * size);
    })
    .join('');
  const hub = 0.14 * size;
  const home =
    sk(cx - hub / 2, cy - hub / 2, hub, hub, blob(hub, hub), {
      seed: 5,
      fill: hl,
      bw: 3,
      amp: 1.6,
    }) + icon(HOME_ICON, cx, cy, hub * 0.55, 2.2);
  return rings + labels + dots + home;
}

function page(width: number, height: number, svg: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fonts}
html,body{margin:0;width:${width}px;height:${height}px;overflow:hidden}
svg{display:block}
</style></head><body><svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${svg}</svg></body></html>`;
}

const dotPattern = (size: number, r: number) =>
  `<defs><pattern id="dots" width="${size}" height="${size}" patternUnits="userSpaceOnUse"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="${dotGrid}"/></pattern></defs>`;

function ogCard() {
  const W = 1200;
  const H = 630;
  const logo = 96;
  const left = 84;
  const svg = [
    dotPattern(26, 1.6),
    `<rect width="${W}" height="${H}" fill="${paper}"/><rect width="${W}" height="${H}" fill="url(#dots)"/>`,
    // logo: the yellow highlighter blob with the radar glyph, then the wordmark
    sk(left, 112, logo, logo, blob(logo, logo), { seed: 3, fill: hl, bw: 4, amp: 2.2 }),
    icon(RADAR_ICON, left + logo / 2, 112 + logo / 2, logo * 0.6, 2.1),
    `<text x="${left + logo + 26}" y="${112 + logo / 2 + 27}" font-family="Shantell Sans" font-weight="800" font-size="78" letter-spacing="-1.6" fill="${ink}">grub radar</text>`,
    // tagline: highlighter swipe behind "eat?" like the app's headlines (placed once the font is in)
    `<rect data-hl-for="tagline" data-hl-word="eat?" y="326" height="32" rx="4" fill="${hl}"/>`,
    `<text id="tagline" x="${left}" y="350" font-family="Shantell Sans" font-weight="800" font-size="52" letter-spacing="-1" fill="${ink}">where should we eat?</text>`,
    `<text x="${left + 2}" y="430" font-family="Caveat" font-weight="700" font-size="44" fill="${pencil}">a hand-drawn radar of places near you.</text>`,
    // legend, in the app's kind marks
    mark('food', left + 14, 506, 24),
    `<text x="${left + 38}" y="516" font-family="Shantell Sans" font-weight="600" font-size="27" fill="${ink}">food</text>`,
    mark('coffee', left + 136, 506, 24),
    `<text x="${left + 160}" y="516" font-family="Shantell Sans" font-weight="600" font-size="27" fill="${ink}">coffee</text>`,
    mark('bakery', left + 284, 506, 24),
    `<text x="${left + 308}" y="516" font-family="Shantell Sans" font-weight="600" font-size="27" fill="${ink}">bakery</text>`,
    radar(962, 318, 476),
  ].join('');
  return page(W, H, svg);
}

/** The favicon's design (yellow blob + radar glyph) on a full-bleed paper square. */
function appIcon(size: number, opts: { background: boolean }) {
  const pad = opts.background ? size * 0.12 : size * 0.02;
  const d = size - pad * 2;
  const bw = Math.max(1.6, size / 40);
  const bg = opts.background ? `<rect width="${size}" height="${size}" fill="${paper}"/>` : '';
  return page(
    size,
    size,
    bg +
      sk(pad, pad, d, d, blob(d, d), { seed: 3, fill: hl, bw, amp: size >= 64 ? size / 90 : 0 }) +
      icon(RADAR_ICON, size / 2, size / 2, d * 0.66, size >= 64 ? 2 : 2.4),
  );
}

const browser = await chromium.launch();
async function render(file: string, html: string, width: number, height: number) {
  const p = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await p.setContent(html);
  await p.evaluate(async () => {
    await document.fonts.ready;
    // size highlighter swipes to the word they sit behind
    for (const rect of document.querySelectorAll('rect[data-hl-for]')) {
      const text = document.getElementById(rect.getAttribute('data-hl-for') ?? '');
      const word = rect.getAttribute('data-hl-word') ?? '';
      if (!(text instanceof SVGTextElement)) continue;
      const start = text.textContent.lastIndexOf(word);
      const x0 = text.getStartPositionOfChar(start).x;
      const x1 = text.getEndPositionOfChar(start + word.length - 1).x;
      rect.setAttribute('x', String(x0 - 6));
      rect.setAttribute('width', String(x1 - x0 + 12));
      rect.setAttribute('transform', `rotate(-1.2 ${(x0 + x1) / 2} 342)`);
    }
  });
  const png = await p.screenshot({ omitBackground: true, type: 'png' });
  await p.close();
  const out = new URL(`public/${file}`, root);
  writeFileSync(out, png);
  console.log(`${file}  ${width}×${height}  ${Math.round(statSync(out).size / 1024)} KB`);
}

await render('og.png', ogCard(), 1200, 630);
await render('apple-touch-icon.png', appIcon(180, { background: true }), 180, 180);
await render('favicon-32.png', appIcon(32, { background: false }), 32, 32);
await browser.close();
