# Architecture

grub radar is a React single-page app and one Cloudflare Worker, deployed together. The
Worker answers `/api/*`, `/auth/*` and the agent paths; every other URL is a static file
from the build (or `index.html`). Data lives in D1 (accounts, places, everyone's own list),
R2 (photo bytes) and KV (the OAuth server's store).

See also: [data.md](data.md) for storage, [auth.md](auth.md) for sign-in,
[agents.md](agents.md) for the agent door, [api.md](api.md) for endpoints.

## Code layout

```
src/
  domain/     framework-free TypeScript: Spot schema (zod), travel-time heuristic, sorting and
              filters, findNearby, roll, pickHeadline, the SpotRepository interface, and the
              write operations (edits.ts: add_spot / edit / mark_been / add_note). No React, no DOM.
  copy/       editable UI copy (time-of-day headlines, per language).
  i18n/       locales, the typed message catalog, language provider, zh font loading.
  contracts/  wire schemas (zod) shared by the SPA and the Worker.
  data/       where spots come from: HttpSpotRepository (the app), MemorySpotRepository and
              StaticSpotRepository over the demo seed (tests).
  lib/        React glue: auth, origin (home / geolocation), spots context, radar geometry,
              photo processing, ink paths.
  components/, pages/   the UI (pages/admin is a lazily loaded chunk).
worker/
  index.ts    the fetch handler (Hono) and the hourly cron.
  auth/       Sign in with Apple, the sign-in hand-off, sessions, CSRF, principals.
  agents/     the OAuth server, consent page, MCP server, agent docs.
  routes/     REST routes. db/ D1 access. services/ Apple Maps, spot operations. lib/ helpers.
migrations/   D1 SQL migrations.
e2e/          Playwright specs and the Apple stub.
scripts/      dev secrets, security headers, link previews, perf and font reports, README shots.
```

The UI reads spots only through `SpotRepository` (`list()`, `get(id)`, plus an optional
synchronous `snapshot()` for in-memory sources); it never imports the seed file. The seed is
validated lazily, so bad data shows an error in the app instead of a blank page.

The boundaries are enforced twice:

- **ESLint**: `src/domain` can't import React, app code or config, and can't touch browser
  globals (`window`, `location`, `fetch`, `globalThis`, ...). App code can't import the seed
  or the static repository (tests can). `worker/` may import only `src/domain` and
  `src/contracts` (plus the demo seed, for the dev-only import).
- **TypeScript**: `tsconfig.domain.json` typechecks the domain on its own with no DOM lib, so
  a stray browser API fails `tsc -b`, not just lint. The Worker typechecks without the DOM
  (`tsconfig.worker.json`).

The domain operations map 1:1 onto REST endpoints and MCP tools; both call the same
`worker/services/spots.ts` / `D1SpotRepository`:

| tool            | domain                                             | REST                        |
| --------------- | -------------------------------------------------- | --------------------------- |
| `list_spots`    | `SpotRepository.list()`                            | `GET /api/spots`            |
| `find_nearby`   | `findNearby(spots, { origin, maxMinutes, kinds })` | `GET /api/spots/nearby`     |
| `roll`          | `roll(candidates, previousId)`                     | `POST /api/roll`            |
| `search_places` | Apple Maps search (`worker/services/appleMaps.ts`) | `GET /api/places/search`    |
| `add_spot`      | `WritableSpotRepository.add(AddSpot)`              | `POST /api/spots`           |
| `mark_been`     | `WritableSpotRepository.markBeen(id, MarkBeen)`    | `POST /api/spots/:id/been`  |
| `add_note`      | `WritableSpotRepository.addNote(id, AddNote)`      | `POST /api/spots/:id/notes` |

## Views and URLs

Phone first (~390px wide), with a desktop layout at ≥960px (card grid, with a radar and
"can't decide? roll" on the side). Signed out, every URL shows the login wall.

- `/` list. `?mode=near|weekend|coffee`, `?tag=spicy`, `?q=search`, `?roll=<spot id>`
  - **near me**: food within 20 min. **weekend**: anything but coffee, further than 20 min.
    **coffee**: coffee + bakeries within 30 min. Thresholds live in `src/domain/modes.ts`.
  - The list is sorted by actual distance ("closest first"). Travel minutes are an estimate
    shown on each card; the radar's rings use them.
  - Search looks across every spot (name, cuisine, tags, notes, dishes) regardless of mode.
    It ignores case, accents, apostrophes (straight or curly) and punctuation, so `mama kos`
    finds "Mama Ko's".
- `/place/:id` one spot: mark it been with a verdict (loved it / it was fine / nope: three
  stamps), change the verdict or move it back to "want to try", tick off and edit "order
  this", add dated notes, photos, who sees it (friends / just me), edit, delete. Friends who
  have been show their verdicts here.
- `/add` find a place on Apple Maps (restaurants, cafés, bakeries around where you measure
  from) and put it on your radar in one tap; `?q=pho` keeps the search. Places already on
  your list say so and open your entry. Apple's places appear only here, never on the list or
  radar.
- `/add/manual` add a spot by hand (name, kind, where: "use where i am" or `lat, lng`,
  cuisine, price (or "?", not sure), cravings, status/verdict, one-liner, doodle); `?name=`
  prefills it. `/place/:id/edit` is the same form (a place from Apple Maps keeps Apple's name
  and location).
- `/radar` `?reach=0..3` (10 min … road trip), `?kinds=food,coffee`, `?sel=<spot id>`. Rings
  are travel time, dots are spots, coloured and shaped by kind.
- `/friends` invite a friend (a single-use link, offered to the share sheet or copied), your
  links still waiting (revocable), your friends (unfriend), and how friends see you (name +
  emoji). `/friends/:id` a friend's shared list. `/invite#<token>` an invite link (the token
  in the fragment): sign in, see who sent it, accept.
- `/settings` connect an agent, the agents you connected (disconnect), personal tokens. See
  [agents.md](agents.md).
- `/admin` owner only (see [auth.md](auth.md#admin)); to everyone else, the ordinary
  not-found page.

Every spot has a status (`been` / `want to try`), a one-line note, what to order, an
optional "why it's on the list" from the agent that found it, and a **take me there** button
that opens Apple Maps.

**The headline changes with the time of day.** When the page opens it looks at the local
clock, picks a slot (breakfast 5–11, lunch 11–14, afternoon 14–17, dinner 17–21, late night
21–5, and weekend daytime Sat/Sun 9–17) and a random line from that slot, once per page load.
Weekend daytime also opens the list in **weekend** mode. The copy lives in
[`src/copy/headlines.ts`](../src/copy/headlines.ts); wrap the highlighted words in
`*asterisks*`. The picker is `pickHeadline(date, random)` in `src/domain/headlines.ts`.

**from: home / where i am.** "where i am" asks the browser for its location once; if that's
blocked or times out you get a note and distances stay measured from home. **Home** is yours
to set from the app ("set your home": use where you are now, or type `lat, lng`). It's saved
to your account (`user_private`, returned only by `GET /api/me` to your own session). A home
that v0 left in this browser's `localStorage` is used right away, and you're asked once:
**save your home to your account?** Yes moves it there and removes it from the device; "keep
it on this device only" leaves it local and stops asking. On a device where the account
already has a home, the old device copy is cleared without asking: the account always wins,
so the device copy would never be read again (asking would offer a choice with no effect).
Home writes go one at a time; changing home again while one is in flight writes the newest
choice next, so the server always ends on your latest. Until you set one, distances are
measured from a demo home in downtown Seattle, and the app says so.

## Adding a spot

In the app: **+ add a spot** (desktop header, phone header, or the empty list). Type a name
or a craving ("pho", "serious pie"), tap a result: it's on your list with Apple's Place ID,
name, location and address; set been / verdict / price / notes / kind on the place page.
Apple Maps has no price or cuisine, so those start unknown: a hand-drawn "price?" (cards and
the place page) and "cuisine?" (the place page; cards show the kind) until you say. Can't
find it? "add it by hand". Every account starts with an empty list; spots live in D1 and are
yours alone. How search talks to Apple: [data.md](data.md#apple-maps).

The fictional demo list in [`src/data/seed.ts`](../src/data/seed.ts) is for tests and local
dev only: `POST /api/spots/import-demo` (404 unless `ENVIRONMENT=development`) copies it onto
the signed-in dev user's list, and Playwright uses it. Seed entries look like this:

```ts
{
  id: 'night-owl-pho',            // lowercase-kebab, unique; becomes /place/night-owl-pho
  name: 'Night Owl Pho',
  kind: 'food',                   // food | coffee | bakery
  cuisine: 'pho',                 // optional
  price: '$',                     // $ … $$$$; optional: leave it out if you don't know
  tags: ['soup', 'late night'],   // first tag = what it is; the rest are modifiers
  status: 'want',                 // want | been (verdict good | meh | bad only when been)
  note: 'rare beef, extra basil', // optional, ≤ 60 chars, shown in handwriting
  order: [{ dish: 'pho tai', tried: false }],
  why: { text: 'open till 3am', foundOn: '2026-10-14' }, // optional
  hours: { closes: '03:00' },     // optional; 24h, or 'sold-out'; days: ['fri'] to limit
  icon: 'soup',                   // bowl dumpling taco cup soup bun flame fish croissant
  location: { lat: 47.6152, lng: -122.3201 },
},
```

The seed is fictional and must stay that way: see [security.md](security.md#this-repo-is-public).

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

## Languages: en / 中文

A small **en / 中文** switch sits at the top of every page. The first visit follows the
browser's language (any `zh-*` gets Simplified Chinese); after that your choice is remembered
in `localStorage`, and `<html lang>` follows it.

- **Catalog**: `src/i18n/messages.ts`, a typed object. English defines the shape and Chinese
  must match it exactly, so a missing or misspelt zh string fails `tsc`. Strings with
  `*asterisks*` mark the highlighted words. No i18n library: a typed catalog plus a context
  is all this needs. Admin strings are in `src/i18n/adminMessages.ts`.
- **What's translated**: all UI chrome (modes, chips, radar labels, units like 分钟 / 步行 /
  开车 / 公里, empty states, the set-home panel, aria-labels), plus the Worker's own pages
  ("signing you in…", the agent consent page). Spot data (names, cuisines, notes) stays as
  written.
- **Headlines**: Chinese has its own time-of-day lines in `src/copy/headlines.ts`, written in
  the same casual voice rather than translated (今晚吃点啥？ / 宵夜走起？ / 周末去哪儿吃？).
- **Fonts**: headlines use ZCOOL KuaiLe (站酷快乐体), handwritten notes use Long Cang (龙藏体).
  Both are self-hosted via Fontsource and split into ~90 `unicode-range` slices, so the
  browser downloads only the slices containing characters on screen. They load only when
  Chinese is active: English visitors never fetch them (checked in Playwright).
  `node scripts/zh-fonts.mjs` reports the bytes a first Chinese visit downloads.

## Hand-drawn look and motion

The look follows a hand-drawn mockup: Shantell Sans + Caveat, paper-and-ink colours, and
wobbly hand-drawn outlines.

- **Outlines.** Every sketchy box (`.sk`) gets an `<Ink>` child: an SVG with a wobbly
  rounded-rect path, its fill and its ink shadow. The path is computed in JS
  (`src/lib/inkPath.ts`) from the element's size and CSS `border-radius`, using smooth seeded
  noise, so each element always wobbles the same way. One shared `ResizeObserver` redraws a
  path only when its element changes size. There are no runtime SVG filters: the first
  version used `feTurbulence` + `feDisplacementMap` on every box, which is CPU-rasterised
  (badly so in WebKit) and made window resizing janky.
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

## Link previews and screenshots

- `npm run og-image` redraws the link-preview images (`public/og.png`, icons) from
  `scripts/og-image.ts`.
- The README screenshot (`docs/images/screens.webp`) comes from
  `npx playwright test -c scripts/readme-shots.config.ts`, which signs in dev users with the
  fictional demo list against a local build, then
  `cwebp -q 82 test-results/readme-screens.png -o docs/images/screens.webp`.

## Stack

Vite 8, React 19, TypeScript 6 (strict, `noUncheckedIndexedAccess`), React Router 8, zod 4
(`zod/mini`), plain CSS (custom properties + CSS modules), self-hosted fonts via Fontsource.
Cloudflare Workers (Static Assets, D1, R2, KV, Rate Limiting) with Hono and jose, built by
`@cloudflare/vite-plugin`; `@cloudflare/workers-oauth-provider` and the `agents` MCP server
for the agent door. Vitest 5 + Testing Library, Playwright with axe-core checks, ESLint 10
(typescript-eslint strict, type-checked) + Prettier, GitHub Actions CI.
