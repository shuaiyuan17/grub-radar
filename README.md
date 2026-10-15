# grub radar

A small "where should we eat" web app. Saved food, coffee and bakery spots, sorted by how far
they are from home (or from where you are right now), plus a **radar**: rings are travel time
(10 min / 30 min / 1 hr / road trip) and dots are spots, coloured and shaped by kind.

Every spot has a status (`been` / `want to try`), a one-line note, what to order, an optional
"why it's on the list" from the agent that found it, and a **take me there** button that opens
Apple Maps.

It's built for phones first (~390px wide) and has a proper desktop layout (≥960px: card grid
with a radar and "can't decide? roll" on the side). The look follows a hand-drawn mockup: Shantell
Sans + Caveat, paper-and-ink colours, and borders wobbled by an SVG turbulence filter.

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
  - Search looks across every spot (name, cuisine, tags, notes, dishes) regardless of mode.
- `/place/:id` one spot.
- `/radar` `?reach=0..3` (10 min … road trip), `?kinds=food,coffee`, `?sel=<spot id>`.

**from: home / where i am.** Home is a configured origin. "where i am" asks the browser for its
location once; if that's blocked or times out you get a note and distances stay measured from home.

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

Your real home origin goes in a gitignored env file:

```sh
cp .env.example .env.local
# then edit VITE_HOME="lat,lng"
```

Heads-up: `VITE_*` values are compiled into the JavaScript bundle. If you deploy a build made
with your real `VITE_HOME`, anyone who opens the site can read it. Leave it unset for public
deploys, or keep that deployment private.

## Architecture

```
src/
  domain/   framework-free TypeScript: Spot schema (zod), travel-time heuristic, sorting and
            filters, findNearby, roll, the SpotRepository interface. No React, no DOM.
  data/     where spots come from. v0: StaticSpotRepository over the in-repo seed.
  lib/      React glue: origin (home / geolocation), spots context, radar geometry.
  components/, pages/   the UI.
```

The UI only reads spots through `SpotRepository` (`list()`, `get(id)`); it never imports the
seed file. ESLint enforces both rules: `src/domain` can't import React or app code, and only
`src/data` may import the seed.

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

Vite 8, React 19, TypeScript 6 (strict, `noUncheckedIndexedAccess`), React Router 8, zod 4,
plain CSS (custom properties + CSS modules), self-hosted fonts via Fontsource. Vitest 5 +
Testing Library, Playwright with axe-core checks, ESLint 10 (typescript-eslint strict,
type-checked) + Prettier, GitHub Actions CI.
