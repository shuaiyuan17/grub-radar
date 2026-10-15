# Operations

Running it locally, testing, deploying, and what to watch in production. Configuration lives
in [`wrangler.jsonc`](../wrangler.jsonc).

## Running locally

Needs Node 22.22+ (see `.nvmrc`).

```sh
npm install
npm run dev:vars          # once: writes .dev.vars (gitignored) with fresh local secrets
npm run db:migrate:local  # once per new migration: local D1 under .wrangler/
npm run apple-stub        # in another terminal: a local stand-in for Sign in with Apple and Apple Maps
npm run dev               # http://localhost:5173 (SPA + Worker + local D1)
```

The app is behind a login wall. Locally, "Sign in with Apple" goes to the stub, where you
pick any name and continue ([auth.md](auth.md#local-development)). `.dev.vars.example`
documents every local variable.

| script                      | what it does                                                              |
| --------------------------- | ------------------------------------------------------------------------- |
| `npm run check`             | typecheck + ESLint + Prettier check + all Vitest projects                 |
| `npm run build`             | SPA into `dist/client`, Worker + output config into `dist/grub_radar`     |
| `npm run preview`           | serve the build in workerd, like production                               |
| `npm test`                  | Vitest: `spa` (jsdom), `domain` (node), `worker` (workerd + D1)           |
| `npm run test:e2e`          | Playwright at phone and desktop sizes (starts the stub + preview)         |
| `npm run deploy`            | build, apply D1 migrations (remote), deploy the built Worker + SPA        |
| `npm run deploy:built`      | the last two steps, on an existing build                                  |
| `npm run deploy:dry-run`    | build, then bundle + config check, no upload                              |
| `npm run db:migrate:local`  | apply D1 migrations locally                                               |
| `npm run db:migrate:remote` | apply D1 migrations to the real database                                  |
| `npm run dev:vars`          | write `.dev.vars` (`-- --from-keychain` for the real Apple key, on macOS) |
| `npm run format`            | Prettier                                                                  |
| `npm run og-image`          | redraw the link-preview images (`public/og.png`, icons)                   |

The first `test:e2e` run needs `npx playwright install chromium`. Set `E2E_PORT` /
`APPLE_STUB_PORT` to run two checkouts' e2e side by side. Some specs (friends, photos, name, agents)
save screenshots along the way with `SHOTS_DIR=/some/dir`.

## CI

`.github/workflows/ci.yml`, on every pull request and push to `main`: `npm ci`,
`npm run dev:vars` (throwaway keys), `npm run check`, `npm run deploy:dry-run`, the D1
migrations applied in order on a fresh local database, then Playwright (phone + desktop).
CI never deploys.

## Deploying

`main` deploys itself: Cloudflare **Workers Builds** (configured in the Cloudflare
dashboard, not in this repo) builds every push to `main` and deploys it with
`npm run deploy:built`, which **applies remote D1 migrations first**, then deploys `dist/grub_radar/wrangler.json`,
the config the Vite plugin generates with the SPA attached. So merging a PR with a migration
migrates production; see the migration rules in [data.md](data.md#migrations).

By hand, always `npm run deploy` (or `deploy:built` after a build). A bare `wrangler deploy`
from a fresh checkout refuses to run: `wrangler.jsonc` has no `assets.directory` on purpose.
There is no `*.workers.dev` URL and no preview URLs (`workers_dev` / `preview_urls` off),
since those would run against the production D1 and secrets.

## Secrets

Production, set with `wrangler secret put`:

| secret              | what                                                                                           |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `APPLE_PRIVATE_KEY` | the ES256 `.p8` as PEM; signs SIWA client secrets, MapKit JS tokens, the Maps Server API token |
| `SESSION_HMAC_KEY`  | 32+ random bytes; seals the sign-in state and hand-off                                         |
| `OWNER_APPLE_SUB`   | optional: the one Apple ID that may sign up while sign-up is closed                            |
| `ADMIN_APPLE_SUBS`  | optional: comma-separated Apple subs allowed on `/admin` (unset = nobody)                      |

Plain vars (`ENVIRONMENT`, Apple team / client / key ids, `PUBLIC_ORIGIN`, `SIGNUP_OPEN`) are
in `wrangler.jsonc`. Locally everything lives in `.dev.vars` (gitignored; see
`.dev.vars.example`). How to look up an Apple `sub` for the optional two:
[auth.md](auth.md#who-can-sign-up).

## Rate limits

Workers Rate Limiting bindings, all 60-second windows. Each needs its own `namespace_id`;
pick the next free one (`1009`) for a new limiter.

| binding                | namespace | limit | keyed by   | protects                                                                   |
| ---------------------- | --------- | ----- | ---------- | -------------------------------------------------------------------------- |
| `MAPKIT_TOKEN_LIMITER` | 1001      | 20    | user       | `GET /api/mapkit-token`                                                    |
| `WRITE_LIMITER`        | 1002      | 60    | user       | writes to your list and home (add, edit, been, notes, delete)              |
| `SEARCH_LIMITER`       | 1003      | 30    | user       | Apple Maps searches and lookups (25,000 a day for the whole app)           |
| `PHOTO_UPLOAD_LIMITER` | 1004      | 20    | user       | photo uploads, on top of `WRITE_LIMITER`                                   |
| `CALLBACK_LIMITER`     | 1005      | 30    | client IP  | `POST /auth/callback`                                                      |
| `AGENT_LIMITER`        | 1006      | 120   | credential | every agent request (MCP and REST)                                         |
| `OAUTH_LIMITER`        | 1007      | 30    | client IP  | `/authorize`, `/oauth/*`                                                   |
| `BEARER_FAIL_LIMITER`  | 1008      | 20    | client IP  | bad bearer tokens; past it, that IP's tokens aren't looked up for a minute |

Other caps live in SQL: 1000 spots per list, 20 invite links a day, 200 friends, 6 photos per
spot and 200 MB per person, 10 personal tokens, 20 consent pages per person per day, and
client registrations at 5 per IP and 50 in all per day (`daily_counts`).

## KV budget

Free plan: 1,000 writes, 1,000 deletes, 1,000 lists, 100,000 reads a day. Only the OAuth
library uses `OAUTH_KV`.

| what                                    | KV cost                                    | cap                                             |
| --------------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| a client registers (DCR)                | 1 write                                    | 5 per IP and 50 in all per day (`daily_counts`) |
| a consent page opens                    | 1 write, then 1 delete when answered       | 20 per person per day                           |
| "allow"                                 | 1 write (grant) + 1 list (replaced grants) |                                                 |
| code → tokens                           | 2 writes                                   |                                                 |
| a refresh (every ~4 h per active agent) | 2 writes                                   |                                                 |
| each OAuth request (MCP or REST)        | 1 read                                     | `AGENT_LIMITER`, `BEARER_FAIL_LIMITER`          |
| the settings page                       | 1 list                                     |                                                 |
| disconnect                              | 1 list + a few deletes                     |                                                 |

An agent in steady use costs about 12 writes a day; a new connection about 5. Ten busy
agents and a few new connections a day stay under 200 writes. Personal tokens cost no KV at
all.

## Cron

Hourly at minute 23 (`triggers.crons` in `wrangler.jsonc`, `scheduled` in `worker/index.ts`):

- sweep the photo deletion outbox (`photo_deletions`, up to 5000 keys) from R2
  ([data.md](data.md#the-deletion-outbox)),
- delete spent sign-in states that can no longer be valid (`auth_states_used`),
- housekeeping (`worker/db/housekeeping.ts`): sessions that expired or passed the 90-day
  limit, invites that are used, revoked or expired once they're over a day old (the 20-a-day
  cap still counts them until then), and `daily_counts` rows older than yesterday (some are
  keyed by IP address).

Each logs a line only when it did something (`photo sweep`, `spent sign-in states swept`,
`housekeeping`). The [Privacy Policy](https://grub.shuaiyuan.me/privacy) states these
rules: change both together.

## Deleting an account

There is no delete-account endpoint yet. The Privacy Policy promises that on request (to
`CONTACT_EMAIL` in `src/contracts/legal.ts`) we delete the account and the data associated
with it, including photos and agent connections, **within 30 days**. Do it like this.

1. **Find the account.** From the request: the email (matched against
   `auth_identities.email`, which is kept only for this and support) or the display name.
   Confirm it's really theirs (reply from that address) before deleting anything.

   ```sh
   wrangler d1 execute DB --remote --command \
     "SELECT u.id, u.display_name, i.email FROM users u JOIN auth_identities i ON i.user_id = u.id WHERE i.email = '<email>'"
   ```

2. **Revoke Sign in with Apple** while the refresh token still exists. Read it:

   ```sh
   wrangler d1 execute DB --remote --command \
     "SELECT refresh_token FROM auth_identities WHERE user_id = '<user_id>'"
   ```

   then `POST https://appleid.apple.com/auth/revoke` (form-encoded) with `client_id`
   (`APPLE_CLIENT_ID`), `client_secret` (an ES256 JWT minted as in `createClientSecret`,
   `worker/auth/siwa.ts`, with `APPLE_PRIVATE_KEY`), `token=<refresh_token>` and
   `token_type_hint=refresh_token`. 200 means revoked. If there's no token, skip this step.

3. **Disconnect their agents** (OAuth grants and tokens in `OAUTH_KV`, keyed by user id):

   ```sh
   wrangler kv key list --binding OAUTH_KV --remote --prefix "grant:<user_id>:"  > grants.json
   wrangler kv key list --binding OAUTH_KV --remote --prefix "token:<user_id>:"  > tokens.json
   # turn each list into a JSON array of key names, then:
   wrangler kv bulk delete names.json --binding OAUTH_KV --remote
   ```

   Client registrations aren't per person (anyone can register one); an unused one
   expires on its own after 30 days (`CLIENT_REGISTRATION_TTL_S`). Registrations written
   before that setting shipped (15 October 2026) keep the library's earlier default, 90
   days, until they're renewed or expire.

4. **Delete the user row.** D1 enforces foreign keys, so this cascades to
   `auth_identities` (email, Apple sub, refresh token), `sessions`, `user_private` (home),
   `user_places`, `visits`, `friendships` (both directions), `invites` they sent,
   `photos`, `api_tokens`, `agent_grants_seen` and `agent_grants_revoked`. Other people's
   invites they accepted keep the row with `used_by` set to NULL; places they created keep
   `created_by` NULL. Every deleted `photos` row queues its R2 key on `photo_deletions`
   (trigger). In the same command, delete manual places nobody has on a list any more, and
   their per-day consent counter:

   ```sh
   wrangler d1 execute DB --remote --command \
     "DELETE FROM users WHERE id = '<user_id>';
      DELETE FROM places WHERE apple_place_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM user_places WHERE place_id = places.id);
      DELETE FROM daily_counts WHERE key = 'consent:<user_id>';"
   ```

5. **Photos in R2.** The hourly cron tries the queued keys, retrying hourly up to 10 times,
   but that alone doesn't guarantee completion: the manual purge and check below do. Delete
   everything under the person's prefix `u/<user_id>/` (which also catches an object whose
   upload died between R2 and D1) and confirm it lists empty: in the dashboard
   (R2 → `grub-radar-photos` → prefix `u/<user_id>/`), or with any S3 client against R2's
   S3 API, e.g. `aws s3 rm s3://grub-radar-photos/u/<user_id>/ --recursive --endpoint-url
https://<account_id>.r2.cloudflarestorage.com`. (`purgeUserPhotos` in
   `worker/db/photos.ts` does the same in code, for a future in-app delete.) Check
   `photo_deletions` has no rows left at `attempts >= 10` for that prefix.

6. **Check** that `SELECT COUNT(*) FROM users WHERE id = '<user_id>'` is 0 and the KV
   lists above come back empty, then reply to confirm. Workers Logs may include request
   URLs and headers; they're used only for security and debugging and expire after the
   retention period (at most 7 days). The search cache expires after 15 minutes.

## Timing and logs

Workers Logs and observability are on (`observability.enabled`), with source maps uploaded.
`worker/lib/timing.ts` and `worker/lib/timedD1.ts`:

- Every `/api/*` and `/auth/*` answer carries a **`Server-Timing`** header: `session`,
  `agent` (bearer lookup), `apple_token`, `apple_maps`, `jwks`, `jwks_refetch`,
  `id_token_verify`, `signin_db`, `r2_put`, one `d1_N` per D1 round trip with its SQL shape,
  `d1;desc="N round trips"`, and `total`. `/mcp`, `/oauth/*` and `/authorize` don't get it.
- Each of those requests logs one **`request timing`** record with the same phases
  (`phases`, `total_ms`) plus `d1_round_trips`, `d1_statements`, `d1_calls` (SQL labels),
  `d1_sql_ms` (time inside D1), `d1_wall_ms`, `d1_rows_read`, `d1_rows_written`,
  `d1_served_by` (D1's region/colo), `apple_cache` (`hit`/`miss`) and, for sign-in,
  `jwks_source` (`memory`/`cache`/`network`), `jwks_refetched`, `signin_outcome` and, on the
  callback, `siwa_state` (`cookie` / `signed-state-only`: which proof the state came with).
- Names and numbers only: no tokens, codes or user data.

D1 round trips per request: callback 1 (spending the state), finish 1, `/api/me` 1,
`/api/spots` 1, logout 1, no cookie 0. `worker/routes/roundtrips.test.ts` reads them back
from the header, so a regression fails a test.

Unhandled errors log `unhandled` with the error name and message, and answer
500 `internal`.
