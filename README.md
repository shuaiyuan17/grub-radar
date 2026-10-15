# grub radar

A small "where should we eat" web app. Saved food, coffee and bakery spots, sorted by how far
they are from home (or from where you are right now), plus a **radar**: rings are travel time
(10 min / 30 min / 1 hr / road trip) and dots are spots, coloured and shaped by kind.

Every spot has a status (`been` / `want to try`), a one-line note, what to order, an optional
"why it's on the list" from the agent that found it, and a **take me there** button that opens
Apple Maps.

It's built for phones first (~390px wide) and has a proper desktop layout (≥960px: card grid
with a radar and "can't decide? roll" on the side). The look follows a hand-drawn mockup: Shantell
Sans + Caveat, paper-and-ink colours, and wobbly hand-drawn outlines (see **Hand-drawn look
and motion** below).

## Run it

Needs Node 22.22+ (see `.nvmrc`).

```sh
npm install
npm run dev          # http://localhost:5173
```

| script             | what it does                                      |
| ------------------ | ------------------------------------------------- |
| `npm run check`    | typecheck + ESLint + Prettier check + unit tests  |
| `npm run build`    | static build into `dist/`                         |
| `npm run preview`  | serve the build                                   |
| `npm test`         | unit + component tests (Vitest, Testing Library)  |
| `npm run test:e2e` | Playwright smoke tests at phone and desktop sizes |
| `npm run format`   | Prettier                                          |

The first `test:e2e` run needs `npx playwright install chromium`.

`dist/` is a plain static SPA, ready for Cloudflare Pages (with no `404.html`, Pages serves
`index.html` for unknown paths, so `/place/...` and `/radar` deep links work).

## Views and URLs

- `/` list. `?mode=near|weekend|coffee`, `?tag=spicy`, `?q=search`, `?roll=<spot id>`
  - **near me**: food within 20 min. **weekend**: anything but coffee, further than 20 min.
    **coffee**: coffee + bakeries within 30 min. Thresholds live in `src/domain/modes.ts`.
  - The list is sorted by actual distance ("closest first"). Travel minutes are an estimate
    shown on each card; the radar's rings use them.
  - Search looks across every spot (name, cuisine, tags, notes, dishes) regardless of mode.
    It ignores case, accents, apostrophes (straight or curly) and punctuation, so
    `mama kos` finds "Mama Ko's".
- `/place/:id` one spot.
- `/radar` `?reach=0..3` (10 min … road trip), `?kinds=food,coffee`, `?sel=<spot id>`.

**The headline changes with the time of day.** When the page opens it looks at the local
clock, picks a slot (breakfast 5–11, lunch 11–14, afternoon 14–17, dinner 17–21, late night
21–5, and weekend daytime Sat/Sun 9–17) and a random line from that slot, once per page load.
Weekend daytime also opens the list in **weekend** mode. The copy lives in
[`src/copy/headlines.ts`](src/copy/headlines.ts); wrap the highlighted words in `*asterisks*`.
The picker is `pickHeadline(date, random)` in `src/domain/headlines.ts`.

**from: home / where i am.** "where i am" asks the browser for its location once; if that's
blocked or times out you get a note and distances stay measured from home. **Home** is yours to
set from the app ("set your home": use where you are now, or type `lat, lng`). It's saved in
this browser's `localStorage` only. Until you set one, distances are measured from a demo home
in downtown Seattle, and the app says so.

## Languages: en / 中文

A small **en / 中文** switch sits at the top of every page. The first visit follows the
browser's language (any `zh-*` gets Simplified Chinese), after that your choice is remembered
in `localStorage`, and `<html lang>` follows it.

- **Catalog**: `src/i18n/messages.ts`, a typed object. English defines the shape and Chinese
  must match it exactly, so a missing or misspelt zh string fails `tsc`. Strings with
  `*asterisks*` mark the highlighted words. No i18n library: a typed catalog plus a context
  is all this needs.
- **What's translated**: all UI chrome (modes, chips, radar labels, units like 分钟 / 步行 /
  开车 / 公里, empty states, the set-home panel, aria-labels). Spot data (names, cuisines,
  notes) stays as written.
- **Headlines**: Chinese has its own time-of-day lines in `src/copy/headlines.ts`, written
  in the same casual voice rather than translated (今晚吃点啥？ / 宵夜走起？ / 周末去哪儿吃？).
- **Fonts**: headlines use ZCOOL KuaiLe (站酷快乐体), handwritten notes use Long Cang
  (龙藏体). Both are self-hosted via Fontsource and split into ~90 `unicode-range` slices, so
  the browser downloads only the slices containing characters on screen. They load only when
  Chinese is active: English visitors never fetch them (checked in Playwright).
  `node scripts/zh-fonts.mjs` reports the bytes a first Chinese visit downloads.

## How travel time is estimated

No routing API, no keys. From the great-circle (haversine) distance:

1. **Street distance** = crow-flies distance × 1.3 (streets aren't straight).
2. **Walk** at 4.8 km/h. If that's **20 min or less**, it's a walk.
3. Otherwise **drive**: 4 min overhead (getting to the car, parking), then the first 8 km of
   street at 30 km/h (city) and the rest at 80 km/h (highway).

All of those are named constants in `src/domain/travel.ts`, and `travel.test.ts` pins the
behaviour at each threshold. The Apple Maps link asks for walking or driving directions to
match: `https://maps.apple.com/?daddr=<lat>,<lng>&q=<name>&dirflg=w|d`.

It's an estimate: it doesn't know about water, hills or traffic. Good enough to sort a list
and draw rings.

## Add a spot

Append an object to `SEED_SPOTS` in [`src/data/seed.ts`](src/data/seed.ts):

```ts
{
  id: 'night-owl-pho',            // lowercase-kebab, unique; becomes /place/night-owl-pho
  name: 'Night Owl Pho',
  kind: 'food',                   // food | coffee | bakery
  cuisine: 'pho',
  price: '$',                     // $ … $$$$
  tags: ['soup', 'late night'],   // first tag = what it is; the rest are modifiers
  status: 'want',                 // want | been (rating 1-10 only when been)
  note: 'rare beef, extra basil', // ≤ 60 chars, shown in handwriting
  order: [{ dish: 'pho tai', tried: false }],
  why: { text: 'open till 3am', foundOn: '2026-10-14' }, // optional
  openTill: '3am',                // optional
  icon: 'soup',                   // bowl dumpling taco cup soup bun flame fish croissant
  location: { lat: 47.6152, lng: -122.3201 },
},
```

The data is validated with zod when the app loads and in `npm test`, so a typo fails loudly.

## Privacy: this repo is public

Everything in `src/data/seed.ts` is **fictional demo data** scattered around a demo origin in
downtown Seattle. Don't commit real addresses, real names or private notes.

Your real home is **never** in the code, the config or the build: there is no env var for it.
You set it in the app and it lives in your browser's `localStorage` on that device. The site
can be deployed publicly without leaking where you live.

## Hand-drawn look and motion

- **Outlines.** Every sketchy box (`.sk`) gets an `<Ink>` child: an SVG with a wobbly
  rounded-rect path, its fill and its ink shadow. The path is computed in JS
  (`src/lib/inkPath.ts`) from the element's size and CSS `border-radius`, using smooth seeded
  noise, so each element always wobbles the same way. One shared `ResizeObserver` redraws a
  path only when its element changes size. There are no runtime SVG filters: the first version
  used `feTurbulence` + `feDisplacementMap` on every box, which is CPU-rasterised (badly so
  in WebKit) and made window resizing janky.
- **Boil** (outlines swapping like hand-drawn animation) only runs while you hover or focus
  the logo or a dice button. Nothing animates at idle.
- **Motion** is light and only uses `transform` and `opacity`: cards stagger in on load and
  on mode/chip changes, buttons squash a little when pressed, radar dots pop out from home,
  out-of-reach dots fade, the dice wiggles when you roll, the headline highlighter draws in
  once, and route changes cross-fade via the View Transitions API (a no-op where it isn't
  supported). Timings and easings are CSS custom properties at the top of
  `src/styles/global.css`.
- **`prefers-reduced-motion: reduce` turns all of it off**, which Playwright checks.
- `node scripts/perf.mjs <url>` measures resize frame times and idle work against a running
  `npm run preview` (see the script for options).

## Architecture

```
src/
  domain/   framework-free TypeScript: Spot schema (zod), travel-time heuristic, sorting and
            filters, findNearby, roll, pickHeadline, the SpotRepository interface. No React, no DOM.
  copy/     editable UI copy (time-of-day headlines, per language).
  i18n/     locales, the typed message catalog, language provider, zh font loading.
  data/     where spots come from. v0: StaticSpotRepository over the in-repo seed.
  lib/      React glue: origin (home / geolocation), spots context, radar geometry.
  components/, pages/   the UI.
```

The UI only reads spots through `SpotRepository` (`list()`, `get(id)`, plus an optional
synchronous `snapshot()` for in-memory sources); it never imports the seed file. The seed is
validated lazily, so bad data shows an error in the app instead of a blank page. The
boundaries are enforced twice:

- **ESLint**: `src/domain` can't import React, app code or config, and can't touch browser
  globals (`window`, `location`, `fetch`, `globalThis`, ...). Only `src/data` may import the
  seed.
- **TypeScript**: `tsconfig.domain.json` typechecks the domain on its own with no DOM lib, so
  a stray browser API fails `tsc -b`, not just lint.

The domain operations are shaped to map 1:1 onto future API endpoints / MCP tools:

| tool          | domain                                                    | v0      |
| ------------- | --------------------------------------------------------- | ------- |
| `find_nearby` | `findNearby(spots, { origin, maxMinutes, kinds })`        | ✅      |
| `roll`        | `roll(candidates, previousId)`                            | ✅      |
| `add_spot`    | `WritableSpotRepository.add(input)` (validated by schema) | planned |
| `mark_been`   | `WritableSpotRepository.markBeen(id, rating?)`            | planned |
| `add_note`    | `WritableSpotRepository.addNote(id, note)`                | planned |

Planned later, not built yet: a Cloudflare Workers + D1 backend implementing
`WritableSpotRepository` behind an HTTP API, a remote MCP server at `/mcp` exposing the tools
above, and the site on Cloudflare Pages. Swapping the data source means writing an
`HttpSpotRepository` and passing it to `<SpotsProvider repository={...}>`; components don't
change.

## Stack

Vite 8, React 19, TypeScript 6 (strict, `noUncheckedIndexedAccess`), React Router 8, zod 4 (`zod/mini`),
plain CSS (custom properties + CSS modules), self-hosted fonts via Fontsource. Vitest 5 +
Testing Library, Playwright with axe-core checks, ESLint 10 (typescript-eslint strict,
type-checked) + Prettier, GitHub Actions CI.
