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
- delete spent sign-in states that can no longer be valid (`auth_states_used`).

Each logs a line only when it did something (`photo sweep`, `spent sign-in states swept`).

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
