# Data: D1, R2, KV

- **D1** (binding `DB`, database `grub-radar-db2`): accounts, sessions, places, everyone's own
  list, friends, photo index, agent tokens.
- **R2** (binding `PHOTOS`, bucket `grub-radar-photos`): photo bytes. Private.
- **KV** (binding `OAUTH_KV`): only the OAuth library's store (clients, grants, tokens, all
  hashed or encrypted by the library). See [agents.md](agents.md) and the
  [KV budget](operations.md#kv-budget).

The access rules these tables enforce are summarised in [security.md](security.md).

## Tables, by migration

| migration                            | adds                                                                                                              |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `0001_init.sql`                      | `users`, `auth_identities`, `sessions`, `user_private` (home)                                                     |
| `0002_places.sql`                    | `places` (global), `user_places` (your list), `visits`                                                            |
| `0003_unknown_price_and_verdict.sql` | rebuilds `user_places` and `visits`: `price` nullable (unknown), the 1-10 rating becomes a good/meh/bad `verdict` |
| `0004_friends.sql`                   | `friendships`, `invites`                                                                                          |
| `0005_photos.sql`                    | `photos`, `photo_deletions` (the R2 outbox) and the `photos_to_outbox` trigger                                    |
| `0006_auth_states_used.sql`          | `auth_states_used` (spent sign-in states)                                                                         |
| `0007_name_set_at.sql`               | `users.name_set_at`, backfilled: every name but the stand-in `'you'` counts as chosen                             |
| `0008_agents.sql`                    | `api_tokens`, `agent_grants_seen`, `agent_grants_revoked`, `daily_counts`                                         |

`users.friend_code` from `0001` is unused (friends are by invite link only) and stays: SQLite
can't drop a `UNIQUE` column in place. `daily_counts` (per-day caps for client registration)
is never swept: one small row per counter (and per IP) per day accumulates. Worth a cron
sweep if it ever grows.

## Migrations

Migrations live in `migrations/` and are applied with Wrangler's D1 migrations
(`npm run db:migrate:local`, `npm run db:migrate:remote`, and as the first step of
`npm run deploy:built`). Worker tests apply the same files (`worker/test/apply-migrations.ts`),
and CI checks they apply cleanly, in order, on a fresh local database.

- **Forward-only and additive** where SQLite allows. Never edit a migration that has been
  applied anywhere: add a new one. Before touching an existing file, check what production
  has applied: `npx wrangler d1 migrations list DB --remote` (or
  `SELECT name FROM d1_migrations`).
- A column whose type, nullability or CHECK changes needs a **table rebuild** (create the new
  table, copy, drop, rename, recreate indexes), as in `0003`.
- **Data migrations get a Worker test** that applies the earlier files, writes old-shape
  rows, then the rest (`worker/db/migrations.test.ts` for `0003`).
- Schema-only migrations get a test that a production-shaped database comes through
  unchanged: `migration0004.test.ts` (friends), `migration0005.test.ts` (photos: existing
  rows untouched, the CHECKs hold the limits, a cascade takes photo rows),
  `migration0006.test.ts`, `migration0007.test.ts` (the backfill), all in `worker/db/`.

## Places vs your list

`places` is global and holds only what a place _is_: name, location, address, Apple Place ID,
who created it. Apple places are shared and deduped by Apple Place ID: adding one someone
already saved reuses that row (no Apple call); adding one already on your list returns your
entry (200, nothing written).

Everything you _say_ about a place (kind, cuisine, price, doodle, hours, tags, status,
verdict, notes, "order this", visibility, found by) is on your own `user_places` row, so on a
shared place each person keeps their own. Only whoever created a manual place can rename or
move it (enforced in the `UPDATE`; your entry update only lands if the place change did).
Deleting a spot removes your entry and visits (and a manual place only you had).

Each person's data is scoped by their `user_id` on every query: the Worker builds a
`D1SpotRepository` for the caller's user and every statement joins through `user_places` for
that user. Tests check a second user can't read or write the first's spots, notes, verdicts
or home through any endpoint (404s, unchanged rows, no visits recorded).

**Brakes**: at most 1000 spots per list (`list_full`, 409), and 60 writes per minute per user
(`WRITE_LIMITER`, 429) across spot writes and home.

## Concurrency

Every `user_places` row has an integer `version`, bumped on every write and returned on every
spot. Edits read the spot, run the shared domain function (`src/domain/edits.ts`) and write
back `WHERE version = ?`. The app sends the `version` it edited with every `PATCH`; if the
spot changed elsewhere meanwhile, that's a **409**, the app fetches the latest copy and says
"updated somewhere else, try again" (so a stale copy of `order` or `tags` never overwrites a
newer one). Server-side appends (`/been`, `/notes`) retry on their own. The SPA also ignores
a write answer older than the copy it already has.

## Friends

`worker/db/friends.ts`, migration `0004`. The only way to become friends is an invite link.
Sending one is consent: whoever opens it, signs in and taps accept is your friend, both ways,
at once (two `friendships` rows, written in one batch). No search, no friend codes, no
one-way follow. Either side can unfriend, which ends it for both.

- A link carries 32 random bytes; D1 keeps only their SHA-256. It works once, for 7 days,
  and its creator can revoke it while unused.
- Accepting is one D1 batch: claim the link (only if unused, unrevoked, unexpired, not your
  own, not already friends, both under 200 friends), then the friendship only if that claim
  was this request's, so two people racing for one link can't both get it. Each accept marks
  its claim with a random id, so the outcome reflects the update that actually happened.
- Limits: 20 links per person per 24 h (counted inside the `INSERT`), 200 friends.
- How the token is kept out of URLs and what a friend may see: [security.md](security.md#friends).

## Photos

`worker/routes/photos.ts`, `worker/db/photos.ts`, `worker/lib/imageGuard.ts`, migration
`0005`.

- Bytes live in the private R2 bucket (no public URL, no r2.dev, no custom domain) under
  `u/<user>/<place>/<id>`. D1's `photos` table is the index and decides who may see what (the
  rule is in [security.md](security.md#photos)).
- The browser shrinks every photo first (`src/lib/photoProcess.ts`: EXIF orientation
  applied, ≤ 1600px, WebP or a JPEG fallback, ~150-300 KB). Uploads are a raw WebP/JPEG body,
  ≤ 1 MB; captions ≤ 140 characters.
- Caps (6 per spot, 200 MB per person) are checked inside the `INSERT`, so parallel uploads
  can't overshoot. Uploads also have their own limiter (`PHOTO_UPLOAD_LIMITER`, 20/min).

### The deletion outbox

R2 can't join a D1 transaction, so R2 keys go through an outbox, `photo_deletions`:

- **Upload** is staged: its key goes on the outbox as pending, the bytes go to R2, then one
  batch inserts the photo row and takes the pending row out (or, if refused, makes it due
  now).
- **Delete**: a trigger queues the key of every deleted photo row (one photo, a spot, a
  place, or an account by cascade).
- **Sweep**: due keys (pending ones only after 15 minutes) are deleted right after the
  request (`waitUntil`) and hourly from the cron trigger, giving up after 10 failures. The
  sweeper never deletes bytes a `photos` row still points at: a committed upload whose
  answer was lost keeps its photo, a rolled-back one is swept.
- `purgeUserPhotos` also sweeps an account's bytes by prefix.

## Apple Maps

`worker/services/appleMaps.ts`, Maps Server API. The Worker signs an ES256 JWT
(`scope: server_api`) with `APPLE_PRIVATE_KEY` and trades it at `GET /v1/token` for a
30-minute access token, cached per isolate and in the Cache API until a minute before it
expires.

- Search is `GET /v1/search?q&searchLocation&includePoiCategories=Restaurant,Cafe,Bakery&resultTypeFilter=Poi&lang`
  (`searchLocation` and `searchRegion` are mutually exclusive at Apple; we send the point).
- The centre is rounded to 2 decimals (~1 km) before it leaves the Worker and is never echoed
  back; `near=home` is resolved server-side.
- Answers are cached in the Cache API (search 15 min, keyed by normalized query + rounded
  centre + language; place lookups a day).
- Adding by Apple id always takes name, location and address from Apple (or the shared row),
  never from the request.
- Apple allows 25,000 calls a day for the whole app: the app debounces typing (350 ms, 2+
  characters, earlier answers remembered), and `SEARCH_LIMITER` brakes each user at 30
  Apple-backed calls a minute. Apple down / out of quota → 503 `maps_unavailable`.
- Locally `APPLE_MAPS_BASE` points at the stub (`e2e/apple-stub.ts`); comment it out to use
  the real API with the real key (`npm run dev:vars -- --from-keychain`).

MapKit JS (the in-app map) gets a 10-minute token from `GET /api/mapkit-token`
(`worker/services/mapkitToken.ts`), bound to our origin, 20/min per user.

## Read replication

Stays off. With it, a read can be served by a replica that hasn't seen the session row the
sign-in just wrote (the first `/api/me` would say "signed out") or the `DELETE` a logout just
did (a revoked session would keep working for a moment). Doing it right means carrying a D1
bookmark from every write to the next request (a cookie), and falling back to the primary for
session checks; the primary is in WNAM, close to where the app is used today, so a nearby
replica would save little. Revisit if users far from WNAM show up in `d1_served_by` /
`d1_wall_ms` ([operations.md](operations.md#timing-and-logs)).
