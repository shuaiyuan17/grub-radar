# AGENTS.md

Notes for coding agents working in this repo. The app: a phone-first React SPA plus one
Cloudflare Worker (D1, R2, KV) at https://grub.shuaiyuan.me. Deep docs are in
[docs/](docs/README.md); read the relevant one before changing an area.

**This repo is public.** No real people, addresses, user data, secrets or internal
references in code, tests, fixtures, screenshots, commits or PRs. Test data is fictional
(`src/data/seed.ts`, names like Ana / Ben / Cyd).

## Repo map

| path                            | what                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/domain/`                   | framework-free logic: Spot schema, travel time, modes, nearby, roll, edits. No React/DOM                              |
| `src/contracts/`                | zod wire schemas shared by the SPA and the Worker (also feed `/openapi.json`)                                         |
| `src/i18n/`                     | typed message catalog (`messages.ts`), locales, zh fonts                                                              |
| `src/copy/`                     | time-of-day headlines, per language                                                                                   |
| `src/components/`, `src/pages/` | the UI; `Ink.tsx` + `src/lib/inkPath.ts` are the hand-drawn sketch kit                                                |
| `src/lib/`, `src/data/`         | React glue, API client, photo processing; spot repositories and the demo seed                                         |
| `worker/`                       | the Worker: `auth/` (SIWA, sessions, CSRF, principals), `agents/` (OAuth, MCP), `routes/`, `db/`, `services/`, `lib/` |
| `migrations/`                   | D1 SQL migrations, applied in order                                                                                   |
| `e2e/`                          | Playwright specs, the Apple stub (`apple-stub.ts`), `session.ts` (dev login)                                          |
| `scripts/`                      | dev secrets, security headers, og image, perf, zh fonts, README screenshots                                           |
| `docs/`                         | architecture, auth, agents, data, api, security, operations                                                           |

## Commands

```sh
npm install && npm run dev:vars && npm run db:migrate:local   # one-time setup
npm run apple-stub   # separate terminal; fake Apple sign-in + Maps
npm run dev          # http://localhost:5173
npm run check        # typecheck + lint + format check + all Vitest projects: run before every commit
npm test             # Vitest only (spa / domain / worker projects)
npm run test:e2e     # Playwright, phone + desktop; builds first; needs `npx playwright install chromium`
npm run test:e2e:webkit   # the layout spec in WebKit (iPhone); macOS only; needs `npx playwright install webkit`
npm run format       # Prettier
npm run deploy:dry-run   # build + bundle/config check, no upload
```

**Deploys:** merging to `main` deploys production automatically (Workers Builds runs
`npm run deploy:built`, which applies remote D1 migrations, then deploys). Never run
`npm run deploy`, `db:migrate:remote` or `wrangler secret put` unless the owner asks. No
`*.workers.dev` or preview URLs exist; they'd hit production data.

## Conventions

- **TypeScript strict**, `noUncheckedIndexedAccess`, ESLint strict type-checked. Respect the
  import boundaries: `src/domain` has no React/DOM/browser globals; `worker/` imports only
  `src/domain` and `src/contracts`; app code never imports the seed. Wire shapes go in
  `src/contracts/` (zod mini) and are validated on both sides.
- **i18n:** every UI string goes in `src/i18n/messages.ts`, English and Chinese both (a
  missing zh key fails `tsc`). Headlines are written, not translated. Spot data isn't
  translated.
- **Look:** use the sketch kit (`.sk` + `<Ink>`), the CSS custom properties in
  `src/styles/global.css` and CSS modules. No runtime SVG filters. Animate only
  `transform`/`opacity`; nothing animates at idle.
- **Reduced motion:** `prefers-reduced-motion: reduce` must turn every animation off
  (Playwright checks).
- **Accessibility:** Playwright runs axe; no serious/critical violations; no horizontal
  scroll at 320px.
- **Tests that catch reverts:** every behaviour change comes with a test that fails without
  it. Worker tests run in workerd against a real local D1 with the real migrations. Prefer
  asserting outcomes (rows, status codes, responses) over implementation details.
- Prose and UI copy: casual, lowercase in the UI, plain words.

## Security invariants (don't break these)

Details and tests: [docs/security.md](docs/security.md).

- **Home privacy:** home lives only in `user_private`, is returned only by `GET /api/me` to
  its own session, and is never in code/config/logs. Agents see only the ~1 km grid-cell
  centre; `origin=home` answers omit spot coordinates.
- **Friends visibility is enforced in SQL:** reads of someone else's data join through
  `friendships` from the viewer's id, keep only `visibility = 'friends'`, and select named
  columns (never home, `myNote`, why, dishes, tags). Never filter in JS instead.
- **CSRF:** cookie writes need JSON, `X-Grub-Request: 1` and same-origin; no CORS headers.
- **Session-only routes:** home, friends, invites, photos, settings/tokens, delete, admin.
  Agents (bearer) reach only spot/place routes by scope; update
  `worker/agents/access.test.ts` when adding a route.
- **EXIF guard:** `worker/lib/imageGuard.ts` is an allowlist; never loosen it to accept
  metadata. Photos are served only after the access check, `private, no-cache`.
- Per-user scoping by `user_id` on every query; limits and caps are enforced inside the SQL
  write, not by a read-then-write.

## Migrations

- **Additive and forward-only.** New file, next number (`0009_…sql`). Rebuild a table only
  when SQLite forces it (see `0003`).
- **Never edit a migration that has been applied.** Before touching any existing migration,
  check production: `npx wrangler d1 migrations list DB --remote` (or query
  `d1_migrations`). If it's applied, write a new one.
- Merging to `main` applies it to production, so it must be safe against existing data. Add a
  Worker test in `worker/db/` that applies earlier migrations, writes production-shaped rows,
  then the new one.
- Details: [docs/data.md](docs/data.md#migrations).

## Reviews and PRs

- Branch from `main`, open a PR, never push to `main` directly. CI (`npm run check`,
  dry-run deploy, migrations, Playwright) must be green.
- A PR says what changed and why, how it was tested, and calls out anything touching the
  invariants above, a migration, `wrangler.jsonc`, or KV/D1 cost.
- Reviewers look for: correctness, the security invariants, a test that would catch a
  revert, i18n (both languages), reduced motion and a11y, and docs updated when behaviour
  described in `docs/` changes.
