# Security and privacy

The invariants below are load-bearing. Each has tests; a change that weakens one needs a
very good reason and a matching test change. The mechanics behind them are in
[auth.md](auth.md), [agents.md](agents.md) and [data.md](data.md).

The user-facing version is the [Privacy Policy](https://grub.shuaiyuan.me/privacy) (and the
[Terms of Service](https://grub.shuaiyuan.me/terms)), rendered by `worker/legal/pages.ts` from
the constants in `src/contracts/legal.ts`. Every claim there is meant to match the code: if a
change here alters what is collected, kept, logged or shared, update the policy and its
"Last updated" date in the same PR.

## This repo is public

Everything in `src/data/seed.ts` is **fictional demo data** scattered around a demo origin
in downtown Seattle. Don't commit real addresses, real names, private notes, secrets or
production data (screenshots included: `scripts/readme-shots.spec.ts` uses the demo list
on a local build). The seed is not in the app bundle: signed-out visitors get the login wall
and nothing else, and the Worker serves spots only to a session or an agent (Playwright
checks the DOM and every network response for it).

Secrets are only ever set with `wrangler secret put` ([operations.md](operations.md#secrets));
locally they live in the gitignored `.dev.vars`.

## Home

Your real home is **never** in the code, the config or the build: there is no env var for
it. You set it in the app and it lives in your account's `user_private` row.

- Only `GET /api/me` returns it, to your own session. It's sent only in the body of
  `PUT /api/me/home`. Home routes are session-only: no agent can read or set it.
- For agents, home is snapped to the centre of its ~1 km grid cell before any distance or
  Apple search is computed, and `find_nearby` / `roll` from `origin=home` leave spot
  coordinates out of their answers ([agents.md](agents.md#home-stays-private)).
  `worker/agents/home.test.ts` trilaterates from three known spots to prove the error stays
  ~800 m.
- Apple Maps searches send a centre rounded to 2 decimals (~1 km), never echoed back.
- Worker tests grep every other response for the home coordinates.

## Each person's data

Every query is scoped by the caller's `user_id` (a `D1SpotRepository` per caller, joining
through `user_places`). Tests check a second user can't read or write the first's spots,
notes, verdicts or home through any endpoint: 404s, unchanged rows, no visits recorded.

## Friends

**What a friend sees is decided in SQL**, not in the app: every read of someone else's data
joins through `friendships` from the viewer's own id and keeps only
`user_places.visibility = 'friends'` (the default; any spot can be set to "just me" on its
page), selecting named columns: name and emoji; the place, kind, cuisine, price, been/want,
verdict and one-liner. Never home, `myNote`, why, dishes or tags. An unchosen name (the
stand-in `'you'`) is selected as `NULL`.

A **shared place** (`GET /api/places/:id/shared`, what a `/place/:id` link shows someone who
doesn't have the spot) is session-only too. Its `place` is only the `places` row's name,
address and location (never `created_by`), the same for everyone; its takes and photos come
from the caller's own friendships under the rule above. A non-friend's answer is the same
whether or not anyone has the place, and a missing place is the same 404 as a malformed id.
Signed out, the wall shows nothing of it, and link previews are the generic site card (no
per-place tags). One thing a link can't hide: a manual place exists only while someone has it
(or once had it); an Apple place outlives its last list. `worker/routes/shared.test.ts`.

Friends endpoints are session-only; the agent scope `friends:read` is reserved and not
wired. Agents can't change `visibility`.

**Invite tokens never reach a server in a URL.** They travel in the link's fragment
(`/invite#<token>`), which browsers never send: not in requests, not in `Referer`, not in
sign-in's `returnTo` (just `/invite`; the tab keeps the token in `sessionStorage` across the
Apple round trip, and invite pages set `referrer` to `no-referrer`). The API takes it only in
request bodies, and preview is braked like a write. `e2e/friends.spec.ts` records every
request and checks the token appears only in those bodies.

## Photos

- **Who may see a photo** is the same rule as friends' spots: the owner, or a friend while
  that spot is `friends`. Anyone else, signed in or not (agents included), gets the same 404
  as a photo that doesn't exist.
- Served with `Cache-Control: private, no-cache`, `ETag` and `Vary: Cookie`: every view
  revalidates through the access check (a cheap 304), so losing access takes effect at once.
- **No GPS, no metadata.** The browser re-encodes every photo through a canvas, which drops
  all metadata, the GPS position included. The Worker doesn't trust that: the **EXIF guard**
  (`worker/lib/imageGuard.ts`) reads the container, checks type and size from the headers,
  and is an allowlist. For JPEG only an exact, thumbnail-free JFIF APP0 (never JFXX) and
  Adobe's APP14 pass; every other APPn and COM is refused (the app strips what canvas
  encoders add: Chrome's ICC APP2, Safari's EXIF APP1 and APP13). For WebP, EXIF/XMP chunks
  and flags are refused. `e2e/photos.spec.ts` uploads a "camera" JPEG with GPS and checks
  what's stored has none.

## CSRF and session-only routes

- Cookie-authenticated writes need JSON, `X-Grub-Request: 1` and a same-origin
  `Sec-Fetch-Site`/`Origin`; no CORS headers anywhere ([auth.md](auth.md#csrf)).
- A bearer token makes the request an agent's whatever cookie it carries; agents reach only
  the spot and place routes. Everything else (home, friends, invites, photos, settings,
  deleting a spot, admin) is **session-only**. `worker/agents/access.test.ts` checks every
  route × every kind of caller.
- Sign-in states are sealed and single use; the cookie-less fallback's login-CSRF trade-off
  is documented in [auth.md](auth.md#the-cookie-less-fallback-and-its-trade-off).

## Security headers

The Worker sets them on its own responses (API responses carry `default-src 'none'`).
Static files get theirs from `dist/client/_headers`, generated at build time
(`scripts/security-headers.ts`): a CSP with `frame-ancestors 'none'` and the inline
language-boot script allowed by hash (no `unsafe-inline`), `nosniff`, Referrer-Policy,
Permissions-Policy, COOP, HSTS. `e2e/headers.spec.ts` checks them on the built site.

## Admin

`/admin` and `/api/admin/*` are indistinguishable from unknown URLs to anyone not in
`ADMIN_APPLE_SUBS`, and the page shows no emails, Apple subs or ids
([auth.md](auth.md#admin)).

## No previews against production

There is no `*.workers.dev` URL and no preview URLs (`workers_dev` / `preview_urls` off),
since those would run against the production D1 and secrets.

## Abuse brakes

Every expensive or public path has a limiter; see [operations.md](operations.md#rate-limits).
