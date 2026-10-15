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
npm run dev:vars          # once: writes .dev.vars (gitignored) with fresh local secrets
npm run db:migrate:local  # once per new migration: local D1 under .wrangler/
npm run apple-stub        # in another terminal: a local stand-in for Sign in with Apple
npm run dev               # http://localhost:5173 (SPA + Worker + local D1)
```

The app is behind a login wall. Locally, "Sign in with Apple" goes to the stub (Apple only
returns people to `https://grub.shuaiyuan.me`), where you pick any name and continue.

| script                      | what it does                                                          |
| --------------------------- | --------------------------------------------------------------------- |
| `npm run check`             | typecheck + ESLint + Prettier check + all Vitest projects             |
| `npm run build`             | SPA into `dist/client`, Worker + output config into `dist/grub_radar` |
| `npm run preview`           | serve the build in workerd, like production                           |
| `npm test`                  | Vitest: `spa` (jsdom), `domain` (node), `worker` (workerd + D1)       |
| `npm run test:e2e`          | Playwright at phone and desktop sizes (starts the stub + preview)     |
| `npm run deploy`            | build, apply D1 migrations (remote), deploy the built Worker + SPA    |
| `npm run deploy:dry-run`    | build, then bundle + config check, no upload                          |
| `npm run db:migrate:local`  | apply D1 migrations locally                                           |
| `npm run db:migrate:remote` | apply D1 migrations to the real database                              |
| `npm run dev:vars`          | write `.dev.vars` (`-- --from-keychain` for the real Apple key)       |
| `npm run format`            | Prettier                                                              |

The first `test:e2e` run needs `npx playwright install chromium`.

## Views and URLs

- `/` list. `?mode=near|weekend|coffee`, `?tag=spicy`, `?q=search`, `?roll=<spot id>`
  - **near me**: food within 20 min. **weekend**: anything but coffee, further than 20 min.
    **coffee**: coffee + bakeries within 30 min. Thresholds live in `src/domain/modes.ts`.
  - The list is sorted by actual distance ("closest first"). Travel minutes are an estimate
    shown on each card; the radar's rings use them.
  - Search looks across every spot (name, cuisine, tags, notes, dishes) regardless of mode.
    It ignores case, accents, apostrophes (straight or curly) and punctuation, so
    `mama kos` finds "Mama Ko's".
- `/place/:id` one spot: mark it been with a rating out of 10, change the rating or move it
  back to "want to try", tick off and edit "order this", add dated notes, edit, delete.
- `/add` add a spot by hand (name, kind, where: "use where i am" or `lat, lng`, cuisine,
  price, cravings, status/rating, one-liner, doodle). `/place/:id/edit` the same form.
- `/radar` `?reach=0..3` (10 min … road trip), `?kinds=food,coffee`, `?sel=<spot id>`.

**The headline changes with the time of day.** When the page opens it looks at the local
clock, picks a slot (breakfast 5–11, lunch 11–14, afternoon 14–17, dinner 17–21, late night
21–5, and weekend daytime Sat/Sun 9–17) and a random line from that slot, once per page load.
Weekend daytime also opens the list in **weekend** mode. The copy lives in
[`src/copy/headlines.ts`](src/copy/headlines.ts); wrap the highlighted words in `*asterisks*`.
The picker is `pickHeadline(date, random)` in `src/domain/headlines.ts`.

**from: home / where i am.** "where i am" asks the browser for its location once; if that's
blocked or times out you get a note and distances stay measured from home. **Home** is yours to
set from the app ("set your home": use where you are now, or type `lat, lng`). It's saved to
your account (`user_private`, returned only by `GET /api/me` to your own session). A home
that v0 left in this browser's `localStorage` is used right away, and you're asked once:
**save your home to your account?** Yes moves it there and removes it from the device; "keep
it on this device only" leaves it local and stops asking. On a device where the account
already has a home, the old device copy is cleared without asking: the account always wins,
so the device copy would never be read again (asking would offer a choice with no effect).
Home writes go one at a time; changing home again while one is in flight writes the newest
choice next, so the server always ends on your latest. Until you set one, distances are measured from a demo home
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

In the app: **+ add a spot** (desktop header, phone header, or the empty list). Every
account starts with an empty list; spots live in D1 and are yours alone.

The fictional demo list in [`src/data/seed.ts`](src/data/seed.ts) is for tests and local
dev only: `POST /api/spots/import-demo` (404 unless `ENVIRONMENT=development`) copies it onto
the signed-in dev user's list, and Playwright uses it. Seed entries look like this:

```ts
{
  id: 'night-owl-pho',            // lowercase-kebab, unique; becomes /place/night-owl-pho
  name: 'Night Owl Pho',
  kind: 'food',                   // food | coffee | bakery
  cuisine: 'pho',                 // optional
  price: '$',                     // $ … $$$$
  tags: ['soup', 'late night'],   // first tag = what it is; the rest are modifiers
  status: 'want',                 // want | been (rating 1-10 only when been)
  note: 'rare beef, extra basil', // optional, ≤ 60 chars, shown in handwriting
  order: [{ dish: 'pho tai', tried: false }],
  why: { text: 'open till 3am', foundOn: '2026-10-14' }, // optional
  hours: { closes: '03:00' },     // optional; 24h, or 'sold-out'; days: ['fri'] to limit
  icon: 'soup',                   // bowl dumpling taco cup soup bun flame fish croissant
  location: { lat: 47.6152, lng: -122.3201 },
},
```

## Privacy: this repo is public

Everything in `src/data/seed.ts` is **fictional demo data** scattered around a demo origin in
downtown Seattle. Don't commit real addresses, real names or private notes. It is not in the
app bundle: signed-out visitors get the login wall and nothing else, and the Worker serves
spots only to a session (Playwright checks the DOM and every network response for it).

Your real home is **never** in the code, the config or the build: there is no env var for it.
You set it in the app and it lives in your account's `user_private` row. Only `GET /api/me`
returns it, to your own session; it's sent only in the body of `PUT /api/me/home`; and
`find_nearby`/`roll` from `origin=home` leave spot coordinates out of their answers. Worker
tests grep every other response for it.

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

## Backend: one Cloudflare Worker

The site is a single Worker with Static Assets (`wrangler.jsonc`). Files in `dist/client` are
served by Cloudflare directly; only the paths in `assets.run_worker_first` (`/api/*`,
`/auth/*`, and the reserved agent paths) run `worker/index.ts` (Hono). D1 (`grub-radar`) holds
accounts, sessions, places and everyone's own list.

| endpoint                       | auth     | what                                                             |
| ------------------------------ | -------- | ---------------------------------------------------------------- |
| `GET /api/health`              | none     | `{ ok, version }`                                                |
| `GET /auth/apple/start`        | none     | 302 to Apple (`?returnTo=/same/origin/path`)                     |
| `POST /auth/callback`          | Apple    | Apple's form_post; the "signing you in…" page, or `/?signin=…`   |
| `POST /auth/finish`            | hand-off | the slow half of sign-in (`t` in the body); 303 with a session   |
| `GET /auth/callback`           | none     | 303 to `/` (never Apple: iOS preloads it, or the back button)    |
| `POST /auth/logout`            | session  | 204, session deleted                                             |
| `GET /api/me`, `PATCH /api/me` | session  | `{ user, home, signupOpen }`; change name / avatar emoji         |
| `PUT /api/me/home`, `DELETE`   | session  | save / clear your home (body `{ lat, lng }`), 204                |
| `GET /api/spots`               | read     | your list (`Spot[]`)                                             |
| `GET /api/spots/:id`           | read     | one of your spots, or 404                                        |
| `GET /api/spots/nearby`        | read     | `find_nearby`: `?origin=home\|lat,lng&maxMinutes&kinds&limit`    |
| `POST /api/spots`              | write    | `add_spot` (manual: name, kind, location + optional fields), 201 |
| `PATCH /api/spots/:id`         | write    | edit; `null` clears; stale `version` → 409; to been = visit      |
| `POST /api/spots/:id/been`     | write    | `mark_been`: `{ rating?, on?, note? }`, records a visit          |
| `POST /api/spots/:id/notes`    | write    | `add_note`: appends `— YYYY-MM-DD: …` to your notes              |
| `DELETE /api/spots/:id`        | write    | 204; your entry and visits go (and a manual place only you had)  |
| `POST /api/roll`               | read     | `roll`: `{ origin, maxMinutes?, kinds?, previousId? }`           |
| `POST /api/spots/import-demo`  | write    | dev only: the fictional demo spots onto your list                |
| `GET /api/mapkit-token`        | session  | 10-minute MapKit JS token with our origin; 20/min per user       |
| `POST /auth/dev-login`         | secret   | `ENVIRONMENT=development` + localhost + `DEV_LOGIN_SECRET` only  |

**Sign in with Apple** (`worker/auth/siwa.ts`): web flow with `response_type=code` and
`response_mode=form_post`. `state` and a hashed `nonce` ride in an HMAC-signed, 10-minute,
single-use `__Host-grub_siwa` cookie (`SameSite=None`, because Apple's callback is a
cross-site POST). The callback checks the state, spends it, and answers at once with a tiny
"signing you in…" page (en/中文). Its one-line inline script (allowed by CSP hash, like its
CSS) submits a same-origin POST form to `/auth/finish` with the hand-off value `t` in the
body, never in a URL; a "continue" button is the no-JS fallback. What crosses over (code, nonce hash, returnTo, previous
session, Apple's one-time `user` field) is AES-GCM-sealed in a two-minute `__Host-grub_signin`
cookie (HttpOnly, Secure, Lax) bound to that random `t`; `/auth/finish`
refuses (and leaves alone) anything without the matching `t`, or not `Sec-Fetch-Site:
same-origin` (without that header: an `Origin` equal to `PUBLIC_ORIGIN`; neither is a no), a GET there just goes home, and the cookie is cleared on first use (`worker/auth/pending.ts`). It then exchanges the code with a
fresh 5-minute ES256 client secret **while** loading Apple's JWKS, verifies the id_token
(RS256; `iss`, `aud`, `exp`, nonce), and finds or creates the user by Apple `sub` and starts
the session in one D1 batch. Apple sends the person's name only on the first authorization;
it's stored then. The JWKS is kept in isolate memory and the Cache API
(`worker/auth/appleKeys.ts`): Apple's `max-age` if it sends one (clamped 5 min–24 h); it sends
`no-store` today, so an hour. An unknown `kid` or a failing signature refetches once (even
when the set came straight from Apple), at most once a minute.

**Sessions** (`worker/auth/session.ts`): a random 32-byte token in `__Host-grub_session`
(HttpOnly, Secure, SameSite=Lax, 30 days sliding, never more than 90 days after sign-in).
D1 stores only its SHA-256. Signing in again ends the browser's previous session. A lookup is
one D1 round trip: the session row joined with its user, plus the route's own reads for the
two hot GETs (`/api/me`, `/api/spots`) in the same batch, scoped in SQL to that live session.
The sliding-expiry / hourly `last_seen_at` write happens only when due, after the response
(`waitUntil`). Logout is a single `DELETE` by the cookie's hash.
**CSRF** (`worker/auth/csrf.ts`): cookie-authenticated writes need JSON, `X-Grub-Request: 1`
and a same-origin `Sec-Fetch-Site`/`Origin`; no CORS headers anywhere. Only a resolved agent
principal (bearer token, later) skips the header/origin checks.

**Security headers**: the Worker sets them on its own responses; static files get theirs
from `dist/client/_headers`, generated at build time (`scripts/security-headers.ts`): a CSP
with `frame-ancestors 'none'` and the inline language-boot script allowed by hash (no
`unsafe-inline`), `nosniff`, Referrer-Policy, Permissions-Policy, COOP, HSTS.

**Dev-only behaviour** (dev login, the Apple stub via `APPLE_ENDPOINT_BASE`, request-origin
redirects) needs `ENVIRONMENT=development` exactly; any other value behaves like production.

**Who can sign up**: `SIGNUP_OPEN` in `wrangler.jsonc`. `"true"` (the launch setting): any
Apple ID. `"false"`: closed; others see "invite-only". While closed, exactly one account can
still be created: if the `OWNER_APPLE_SUB` secret is set, only that Apple ID; if not, only the
very first account. Admission is decided inside the `INSERT` (one D1 transaction with the
identity row), so simultaneous first sign-ins can't both get in. To pin the owner, read his
`sub` (`wrangler d1 execute grub-radar --remote --command "SELECT provider_sub FROM
auth_identities"`) and `wrangler secret put OWNER_APPLE_SUB`.

Each person's data is scoped by their `user_id` on every query: the Worker builds a
`D1SpotRepository` for the caller's user and every statement joins through `user_places` for
that user. Tests check a second user can't read or write the first's spots, notes, ratings or
home through any endpoint (404s, unchanged rows, no visits recorded). "read"/"write" above
mean a signed-in person today, or an agent with `spots:read`/`spots:write` once the agent
door ships; home is session-only.

**Places vs your list**: `places` is global and holds only what a place _is_: name,
location, address, Apple Place ID, who created it. Apple places (PR 3) will be shared and
deduped by Apple Place ID. Everything you _say_ about a place (kind, cuisine, price, doodle,
hours, tags, status, rating, notes, "order this") is on your own `user_places` row, so on a
shared place each person keeps their own. Only whoever created a manual place can rename or
move it (enforced in the `UPDATE`; your entry update only lands if the place change did).

**Concurrency**: every `user_places` row has an integer `version`, bumped on every write and
returned on every spot. Edits read the spot, run the shared domain function
(`src/domain/edits.ts`) and write back `WHERE version = ?`. The app sends the `version` it
edited with every `PATCH`; if the spot changed elsewhere meanwhile, that's a **409**, the app
fetches the latest copy and says "updated somewhere else, try again" (so a stale copy of
`order` or `tags` never overwrites a newer one). Server-side appends (`/been`, `/notes`)
retry on their own. The SPA also ignores a write answer older than the copy it already has.

**Brakes**: at most 1000 spots per list (`list_full`, 409), and 60 writes per minute per
user (`WRITE_LIMITER`, 429) across spot writes and home.

**Secrets** (production, `wrangler secret put`): `APPLE_PRIVATE_KEY` (the ES256 `.p8` as
PEM), `SESSION_HMAC_KEY` (32+ random bytes) and, optionally, `OWNER_APPLE_SUB`. Locally they live in `.dev.vars`
(gitignored; see `.dev.vars.example`).

**Timing** (`worker/lib/timing.ts`, `worker/lib/timedD1.ts`): every `/api/*` and `/auth/*`
answer carries a `Server-Timing` header (`session`, `apple_token`, `jwks`, `id_token_verify`,
`signin_db`, one `d1_N` per D1 round trip with its SQL shape, `d1;desc="N round trips"`,
`total`) and logs one `request timing` record to Workers Logs with the same phases plus
`d1_round_trips`, `d1_statements`, `d1_sql_ms` (time inside D1), `d1_wall_ms`, rows read and
written, `d1_served_by` (D1's region/colo) and, for sign-in, `jwks_source`
(`memory`/`cache`/`network`) and `signin_outcome`. Names and numbers only: no tokens, codes
or user data. D1 round trips per request: callback 0, finish 1, `/api/me` 1, `/api/spots` 1,
logout 1 (tests read them back from the header: `worker/routes/roundtrips.test.ts`).

**Read replication** stays off. With it, a read can be served by a replica that hasn't seen
the session row the sign-in just wrote (the first `/api/me` would say "signed out") or the
`DELETE` a logout just did (a revoked session would keep working for a moment). Doing it
right means carrying a D1 bookmark from every write to the next request (a cookie), and
falling back to the primary for session checks; the owner is in Seattle and the primary is in
WNAM, so a nearby replica would save little. Revisit if users far from WNAM show up in
`d1_served_by`/`d1_wall_ms`.

**Database**: migrations in `migrations/`, applied with Wrangler's D1 migrations
(`db:migrate:*`); Worker tests apply the same files. Forward-only, additive.

**Deploying**: always `npm run deploy` (or `deploy:built` after a build, e.g. in Workers
Builds). It builds, applies migrations, then deploys `dist/grub_radar/wrangler.json`, the
config the Vite plugin generates with the SPA attached. A bare `wrangler deploy` from a fresh
checkout refuses to run (`wrangler.jsonc` has no `assets.directory` on purpose). There is no
`*.workers.dev` URL and no preview URLs (`workers_dev`/`preview_urls` off), since those would
run against the production D1 and secrets.

## Architecture

```
src/
  domain/   framework-free TypeScript: Spot schema (zod), travel-time heuristic, sorting and
            filters, findNearby, roll, pickHeadline, the SpotRepository interface, and the
            write operations (edits.ts: add_spot / edit / mark_been / add_note). No React, no DOM.
  copy/     editable UI copy (time-of-day headlines, per language).
  i18n/     locales, the typed message catalog, language provider, zh font loading.
  contracts/ wire schemas (zod) shared by the SPA and the Worker.
  data/     where spots come from: HttpSpotRepository (the app), MemorySpotRepository and
            StaticSpotRepository over the demo seed (tests).
  lib/      React glue: auth, origin (home / geolocation), spots context, radar geometry.
  components/, pages/   the UI.
worker/     the Cloudflare Worker: auth (SIWA, sessions, CSRF), D1 access, routes. Imports
            only src/domain and src/contracts (ESLint), typechecks without the DOM.
migrations/ D1 SQL migrations.
```

The UI only reads spots through `SpotRepository` (`list()`, `get(id)`, plus an optional
synchronous `snapshot()` for in-memory sources); it never imports the seed file. The seed is
validated lazily, so bad data shows an error in the app instead of a blank page. The
boundaries are enforced twice:

- **ESLint**: `src/domain` can't import React, app code or config, and can't touch browser
  globals (`window`, `location`, `fetch`, `globalThis`, ...). App code can't import the
  seed or the static repository (tests can). `worker/` may import only `src/domain` and
  `src/contracts` (plus the demo seed, for the dev-only import).
- **TypeScript**: `tsconfig.domain.json` typechecks the domain on its own with no DOM lib, so
  a stray browser API fails `tsc -b`, not just lint.

The domain operations map 1:1 onto REST endpoints now and MCP tools later; both call the
same `worker/services/spots.ts` / `D1SpotRepository`:

| tool          | domain                                             | REST                        |
| ------------- | -------------------------------------------------- | --------------------------- |
| `find_nearby` | `findNearby(spots, { origin, maxMinutes, kinds })` | `GET /api/spots/nearby`     |
| `roll`        | `roll(candidates, previousId)`                     | `POST /api/roll`            |
| `add_spot`    | `WritableSpotRepository.add(AddSpot)`              | `POST /api/spots`           |
| `mark_been`   | `WritableSpotRepository.markBeen(id, MarkBeen)`    | `POST /api/spots/:id/been`  |
| `add_note`    | `WritableSpotRepository.addNote(id, AddNote)`      | `POST /api/spots/:id/notes` |

Next: adding spots from Apple Maps POIs, then the agent door (OAuth + a remote MCP server at
`/mcp` exposing the tools above).

## Stack

Vite 8, React 19, TypeScript 6 (strict, `noUncheckedIndexedAccess`), React Router 8, zod 4 (`zod/mini`),
plain CSS (custom properties + CSS modules), self-hosted fonts via Fontsource. Cloudflare
Workers (Static Assets + D1) with Hono and jose, built by `@cloudflare/vite-plugin`. Vitest 5 +
Testing Library, Playwright with axe-core checks, ESLint 10 (typescript-eslint strict,
type-checked) + Prettier, GitHub Actions CI.
