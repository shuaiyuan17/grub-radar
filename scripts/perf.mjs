// Perf probe: resize jank + idle work on the list page.
//   npm run build && npm run preview -- --port 4173   (in another shell)
//   node scripts/perf.mjs [url] [label]
// Headless Chromium by default (HEADED=1 for a real window, DPR=2 for Retina). Numbers are for comparing builds on the
// same machine, not absolute truths.
import { chromium } from '@playwright/test';

const url = process.argv[2] ?? 'http://localhost:4173/';
const label = process.argv[3] ?? 'run';
const RUNS = 3;

const sumBy = (events, names) => {
  const out = Object.fromEntries(names.map((n) => [n, 0]));
  for (const e of events) if (e.ph === 'X' && e.name in out) out[e.name] += (e.dur ?? 0) / 1000;
  return out;
};
const TRACE_NAMES = [
  'RasterTask',
  'Paint',
  'Layout',
  'UpdateLayoutTree',
  'PrePaint',
  'Layerize',
  'RunTask',
];
const CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'cc', 'blink'];

function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

async function measure(browser) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: Number(process.env.DPR ?? 1),
  });
  await page.goto(url);
  await page.waitForSelector('article');
  await page.evaluate(() => document.fonts.ready);
  // let entrance animations finish so idle really is idle
  await page.waitForTimeout(2000);

  // idle: 5s with nothing happening (no probe loop of our own)
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Performance.enable');
  const metric = async (name) =>
    (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === name)?.value ?? 0;
  const runningAnimations = await page.evaluate(
    () => document.getAnimations().filter((a) => a.playState === 'running').length,
  );
  await browser.startTracing(page, { categories: CATEGORIES });
  const task0 = await metric('TaskDuration');
  await page.waitForTimeout(5000);
  const idleTaskMs = ((await metric('TaskDuration')) - task0) * 1000;
  const idleTrace = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const idle = sumBy(idleTrace, TRACE_NAMES);
  const idlePaints = idleTrace.filter((e) => e.name === 'Paint').length;

  // resize 1440 -> 800 -> 1440 in 16px steps, one rendered frame per step
  await page.evaluate(() => {
    window.__long = [];
    new PerformanceObserver((l) =>
      window.__long.push(...l.getEntries().map((e) => e.duration)),
    ).observe({
      type: 'longtask',
      buffered: false,
    });
  });
  const widths = [];
  for (let w = 1440; w >= 800; w -= 16) widths.push(w);
  for (let w = 816; w <= 1440; w += 16) widths.push(w);
  await browser.startTracing(page, { categories: CATEGORIES });
  const steps = [];
  const t0 = Date.now();
  for (const w of widths) {
    const s = performance.now();
    await page.setViewportSize({ width: w, height: 900 });
    await page.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
    );
    steps.push(performance.now() - s);
  }
  const total = Date.now() - t0;

  // in-page resize: animate the root width one step per frame and time the
  // frames themselves (no Playwright round trips in the measurement)
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(300);
  const frames = await page.evaluate(
    (ws) =>
      new Promise((resolve) => {
        const root = document.documentElement;
        const out = [];
        let i = 0;
        let last = performance.now();
        const tick = (now) => {
          if (i > 0) out.push(now - last);
          last = now;
          if (i >= ws.length) {
            root.style.width = '';
            resolve(out);
            return;
          }
          root.style.width = ws[i++] + 'px';
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
    widths,
  );
  const resizeTrace = JSON.parse((await browser.stopTracing()).toString()).traceEvents;
  const resize = sumBy(resizeTrace, TRACE_NAMES);
  const longTasks = await page.evaluate(() => window.__long);
  await page.close();
  return {
    runningAnimations,
    idleTaskMs,
    idle,
    idlePaints,
    steps,
    total,
    resize,
    longTasks,
    frames,
  };
}

// HEADED=1 uses a real window (GPU raster), closer to what you feel when resizing.
const browser = await chromium.launch({ headless: process.env.HEADED !== '1' });
const runs = [];
for (let i = 0; i < RUNS; i++) runs.push(await measure(browser));
await browser.close();

const med = (f) => pct(runs.map(f), 50);
const r = (x) => Math.round(x * 10) / 10;
const report = {
  label,
  url,
  mode: `${process.env.HEADED === '1' ? 'headed (GPU)' : 'headless (software raster)'} @${process.env.DPR ?? 1}x`,
  runs: RUNS,
  resize: {
    steps: runs[0].steps.length,
    totalMs: med((x) => x.total),
    stepP50Ms: r(med((x) => pct(x.steps, 50))),
    stepP95Ms: r(med((x) => pct(x.steps, 95))),
    stepMaxMs: r(med((x) => Math.max(...x.steps))),
    longTasks: med((x) => x.longTasks.length),
    longTaskMs: r(med((x) => x.longTasks.reduce((a, b) => a + b, 0))),
    rasterMs: r(med((x) => x.resize.RasterTask)),
    paintMs: r(med((x) => x.resize.Paint)),
    layoutMs: r(med((x) => x.resize.Layout + x.resize.UpdateLayoutTree)),
  },
  inPageResize: {
    frames: runs[0].frames.length,
    frameP50Ms: r(med((x) => pct(x.frames, 50))),
    frameP95Ms: r(med((x) => pct(x.frames, 95))),
    frameMaxMs: r(med((x) => Math.max(...x.frames))),
    over33Ms: med((x) => x.frames.filter((f) => f > 33.4).length),
  },
  idle5s: {
    paints: med((x) => x.idlePaints),
    rasterMs: r(med((x) => x.idle.RasterTask)),
    paintMs: r(med((x) => x.idle.Paint)),
    runningAnimations: med((x) => x.runningAnimations),
    rendererTaskMs: r(med((x) => x.idleTaskMs)),
  },
};
console.log(JSON.stringify(report, null, 2));
