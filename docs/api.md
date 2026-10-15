# HTTP API

One Worker (`worker/index.ts`, Hono) answers every path listed in `assets.run_worker_first`
in `wrangler.jsonc`: `/api/*`, `/auth/*`, `/mcp`, `/mcp/*`, `/oauth/*`, `/authorize`,
`/.well-known/*`, `/openapi.json`, `/llms.txt`, `/agent-setup.md`, `/privacy`, `/terms`.
Everything else is a static file (or `index.html`) and never costs a Worker request.

The agent-facing subset is described machine-readably at
[`/openapi.json`](https://grub.shuaiyuan.me/openapi.json), generated from the zod contracts in
`src/contracts/`. Wire schemas for everything else are in the same folder.

**auth** column:

- `none`: anyone.
- `session`: a signed-in person (the `__Host-grub_session` cookie). Agents get 403.
- `read` / `write`: a signed-in person, or an agent with `spots:read` / `spots:write`
  ([agents.md](agents.md#scopes)).
- Cookie-authenticated writes also pass the CSRF check ([auth.md](auth.md#csrf)).

Errors are JSON `{ error: { code, message } }` (`src/contracts/errors.ts`).

## Health and auth

| endpoint                | auth     | what                                                            |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `GET /api/health`       | none     | `{ ok, version }`                                               |
| `GET /auth/apple/start` | none     | 302 to Apple (`?returnTo=/same/origin/path`)                    |
| `POST /auth/callback`   | Apple    | Apple's form_post; the "signing you in…" page, or `/?signin=…`  |
| `GET /auth/callback`    | none     | 303 to `/` (never Apple: iOS preloads it, or the back button)   |
| `POST /auth/finish`     | hand-off | the slow half of sign-in (`t` in the body); 303 with a session  |
| `GET /auth/finish`      | none     | 303 to `/`                                                      |
| `POST /auth/logout`     | session  | 204, session deleted                                            |
| `POST /auth/dev-login`  | secret   | `ENVIRONMENT=development` + localhost + `DEV_LOGIN_SECRET` only |

How sign-in works: [auth.md](auth.md).

## You

| endpoint                       | auth    | what                                                     |
| ------------------------------ | ------- | -------------------------------------------------------- |
| `GET /api/me`, `PATCH /api/me` | session | `{ user, home, signupOpen }`; change name / avatar emoji |
| `PUT /api/me/home`, `DELETE`   | session | save / clear your home (body `{ lat, lng }`), 204        |
| `GET /api/mapkit-token`        | session | 10-minute MapKit JS token with our origin; 20/min        |

## Spots and places

| endpoint                        | auth    | what                                                              |
| ------------------------------- | ------- | ----------------------------------------------------------------- |
| `GET /api/spots`                | read    | your list (`Spot[]`)                                              |
| `GET /api/spots/:id`            | read    | one of your spots, or 404                                         |
| `GET /api/spots/nearby`         | read    | `find_nearby`: `?origin=home\|lat,lng&maxMinutes&kinds&limit`     |
| `POST /api/spots`               | write   | `add_spot`: by hand, `{ applePlaceId }` or `{ query, near? }`     |
| `PATCH /api/spots/:id`          | write   | edit; `null` clears; stale `version` → 409; to been = a visit     |
| `POST /api/spots/:id/been`      | write   | `mark_been`: `{ verdict?, on?, note? }`, records a visit          |
| `POST /api/spots/:id/notes`     | write   | `add_note`: appends `— YYYY-MM-DD: …` to your notes               |
| `DELETE /api/spots/:id`         | session | 204; your entry and visits go (and a manual place only you had)   |
| `POST /api/roll`                | read    | `roll`: `{ origin, maxMinutes?, kinds?, previousId? }`            |
| `GET /api/places/search`        | read    | `search_places`: `?q=&near=home\|lat,lng&lang=` → `{ places }`    |
| `POST /api/places/search`       | read    | the same, `{ q, near?, lang? }` in the body (the app)             |
| `GET /api/places/:applePlaceId` | read    | one Apple Maps place (`?lang=`)                                   |
| `POST /api/spots/import-demo`   | write   | dev only (404 otherwise): the fictional demo spots onto your list |

For an agent, `home` in `origin` / `near` is the centre of home's ~1 km grid cell
([agents.md](agents.md#home-stays-private)). Limits: 1000 spots per list (409 `list_full`),
`WRITE_LIMITER` and `SEARCH_LIMITER` ([operations.md](operations.md#rate-limits)).

## Friends and invites

All session-only.

| endpoint                     | auth    | what                                                                                                     |
| ---------------------------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `GET /api/friends`           | session | your friends `{ friends, limit }`                                                                        |
| `GET /api/friends/places`    | session | friends' takes on places on your list, by place id                                                       |
| `GET /api/friends/:id/spots` | session | a friend's shared list; 404 unless you're friends                                                        |
| `DELETE /api/friends/:id`    | session | unfriend, for both of you; 204                                                                           |
| `GET /api/invites`           | session | your invite links that still work                                                                        |
| `POST /api/invites`          | session | a new link (201, token shown once); past 20 a day, 429 `invite_limit`                                    |
| `DELETE /api/invites/:id`    | session | revoke an unused link; 204                                                                               |
| `POST /api/invites/preview`  | session | `{ token }` → who sent it, `open`/`own`/`friends`; 410 if spent                                          |
| `POST /api/invites/accept`   | session | `{ token }` → friends both ways (201), already (200); 400 `own_invite`, 409 `friend_limit`, 410 if spent |

## Photos

| endpoint                  | auth    | what                                                               |
| ------------------------- | ------- | ------------------------------------------------------------------ |
| `GET /api/photos?place=`  | session | your photos of a spot + friends' (who share it) + your usage       |
| `POST /api/photos?place=` | session | raw WebP/JPEG body, ≤ 1 MB, no EXIF/XMP → 201; 6/spot, 200 MB each |
| `GET /api/photos/:id`     | session | the image (`no-cache` + ETag): owner or friends; anyone else 404   |
| `PATCH /api/photos/:id`   | session | `{ caption }` (≤ 140, `''` clears) on one of yours                 |
| `DELETE /api/photos/:id`  | session | one of yours, row and R2 bytes; 204                                |

## Agents and OAuth

| endpoint                                                | auth    | what                                                                   |
| ------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `GET /api/me/agents`                                    | session | connected OAuth agents (grants)                                        |
| `DELETE /api/me/agents/:id`                             | session | disconnect one, 204 (404 if unknown)                                   |
| `GET /api/me/tokens`                                    | session | your personal tokens                                                   |
| `POST /api/me/tokens`                                   | session | `{ name, scopes }` → the secret, once (201); at most 10 (409)          |
| `DELETE /api/me/tokens/:id`                             | session | revoke a personal token, 204                                           |
| `GET /authorize`, `POST /authorize`                     | session | the consent page and its answer (signs in first if needed)             |
| `GET /oauth/resume`                                     | none    | back from sign-in to the pending consent                               |
| `POST /oauth/register`                                  | none    | dynamic client registration; 5 per IP, 50 in all per day               |
| `/oauth/token`, other `/oauth/*`                        | client  | the OAuth library (code → tokens, refresh)                             |
| `GET /.well-known/oauth-authorization-server`           | none    | authorization server metadata                                          |
| `GET /.well-known/oauth-protected-resource/mcp`, `/api` | none    | protected resource metadata                                            |
| `/mcp`                                                  | bearer  | the MCP server (stateless); tools in [agents.md](agents.md#mcp)        |
| `GET /openapi.json`, `/llms.txt`, `/agent-setup.md`     | none    | docs for agents                                                        |
| `GET /privacy`, `/terms`                                | none    | Privacy Policy and Terms of Service: HTML, no script (`worker/legal/`) |

## Admin

| endpoint               | auth  | what                                                                   |
| ---------------------- | ----- | ---------------------------------------------------------------------- |
| `GET /api/admin/stats` | admin | users, sign-ups per day, per-person counts; to anyone else a plain 404 |

See [auth.md](auth.md#admin).
