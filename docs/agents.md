# The agent door: OAuth, MCP, REST

Agents (Claude Code, Codex, Cursor, Claude desktop, a bot) act for one person with that
person's consent. Code in `worker/agents/` and `worker/auth/principal.ts`; people manage
their agents at `/settings` in the app. Endpoints: [api.md](api.md#agents-and-oauth).

For people setting up an agent, the Worker serves its own docs (`worker/agents/docs.ts`):

- [`/agent-setup.md`](https://grub.shuaiyuan.me/agent-setup.md): instructions addressed to
  an agent asked to connect itself: ground rules (ask before running anything, nothing
  global), MCP setup per client (Claude Code, Codex, Cursor, Claude desktop / claude.ai), a
  REST fallback with a personal token and a curl example, and when to use each tool. The
  app's "connect your agent" button copies a sentence pointing at it.
- [`/llms.txt`](https://grub.shuaiyuan.me/llms.txt): a short orientation (MCP, REST, scopes,
  privacy, what an agent may change).
- [`/openapi.json`](https://grub.shuaiyuan.me/openapi.json): OpenAPI 3.1 for the agent REST
  paths, built from the same zod contracts the routes validate with.

## Principals

`worker/auth/principal.ts`. A request with `Authorization: Bearer` is an agent's, whatever
cookie it carries:

- a **personal token** (`grub_pat_…`, D1 `api_tokens`, SHA-256 only), or
- an **OAuth access token** issued for `<origin>/api`.

Without one, the session cookie decides. CSRF follows the resolved principal
([auth.md](auth.md#csrf)). Agents reach exactly the spot and place routes (`read` / `write`
in [api.md](api.md), by scope `spots:read` / `spots:write`; not a shared place,
`GET /api/places/:id/shared`, nor adding one by `placeId`); every `session` route answers an
agent 403 (except photo bytes, `GET /api/photos/:id`, which answers anyone but a signed-in
person with the same 404 as a missing photo). Test: `worker/agents/access.test.ts` (every
route × every kind of caller).

## Scopes

| scope            | grants                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `spots:read`     | list, nearby, roll, one spot, Apple Maps search and lookup        |
| `spots:write`    | add spots, mark been, append notes, PATCH a spot's own fields     |
| `offline_access` | OAuth only: a refresh token                                       |
| `friends:read`   | reserved: in the `Scope` type, never granted, no route accepts it |

Personal tokens take `spots:read` and/or `spots:write`.

## What an agent may write

Add spots, mark them been, append notes, add or remove dishes to order, and PATCH a spot's own fields. Never `visibility`
(private → friends is the person's call) or `myNote` as a whole (agents append with
`POST …/notes`): 403. Removing a spot (it takes visits and photos with it) is session-only.

**"found by"**: stored as `agent:<name>` in `user_places.found_by`, the name sanitised (no
invisible or bidi characters) and cut on whole graphemes to 40 UTF-16 units, the same limit
`SpotSchema.foundBy` checks; `me`, `demo`, `friend:…`, `agent:…` are reserved. A row that
somehow doesn't validate loses its label, never the list.

## OAuth 2.1 server

`worker/agents/oauth.ts`, `worker/agents/authorize.ts`, `worker/agents/consentPage.ts`.
`@cloudflare/workers-oauth-provider` 1.x (split API), in the same Worker.

- Discovery: `/.well-known/oauth-authorization-server`, and protected-resource metadata at
  `/.well-known/oauth-protected-resource/mcp` and `/.well-known/oauth-protected-resource/api`.
  An API 401 carries `WWW-Authenticate: Bearer resource_metadata=…/api`.
- `/oauth/token`, `/oauth/register` (dynamic client registration), and Client ID Metadata
  Documents (fetched only once the person is signed in, never through a redirect; the
  Worker runs with `global_fetch_strictly_public` for SSRF safety). PKCE S256.
- `/authorize` is ours: not signed in → Sign in with Apple → back (`/oauth/resume`; the
  pending request waits in a sealed 10-minute `__Host-grub_authz` cookie) → the consent page
  (client name, redirect host, scopes; en + zh) → the client. It's session-only: a bearer
  token there counts as nobody.
- Access tokens 4 h, refresh sliding 30 days.

**Revocation** is strongly consistent: disconnecting writes `agent_grants_revoked` (D1)
before deleting from KV, and every OAuth bearer is checked against it (one D1 read, in
parallel with the KV read), so a disconnected agent is refused at every edge at once, not
when KV catches up. Re-authorizing a client marks its replaced grant the same way.
`agent_grants_seen` records when a grant was last used, for `/settings`.

## Personal tokens

For agents without OAuth: made on `/settings` (`POST /api/me/tokens { name, scopes }`), the
secret shown once. At most 10 live tokens per person, names up to 40 characters. D1 keeps
only the SHA-256. Revoking is immediate. They cost no KV.

## MCP

`/mcp`, via `createMcpHandler` from `agents/mcp/server` (stateless, behind an
`OAuthResourceServer`; personal tokens work too). Code: `worker/agents/mcp.ts`.

| tool            | scope         | what                                                              |
| --------------- | ------------- | ----------------------------------------------------------------- |
| `list_spots`    | `spots:read`  | the person's list                                                 |
| `find_nearby`   | `spots:read`  | spots within reach of `home` or a point                           |
| `roll`          | `spots:read`  | pick one at random from what's in reach                           |
| `search_places` | `spots:read`  | Apple Maps search                                                 |
| `add_spot`      | `spots:write` | by `applePlaceId`, or a free-text query (adds only a clear match) |
| `mark_been`     | `spots:write` | been, with an optional verdict, date and note                     |
| `add_note`      | `spots:write` | append a dated note                                               |
| `add_dish`      | `spots:write` | add a dish to a spot's "dishes to order" (deduped, ≤ 20)          |
| `remove_dish`   | `spots:write` | take a dish off that list (matched ignoring case and spacing)     |

Write tools need `spots:write`: a 403 step-up challenge at the HTTP layer, and checked again
in each tool.

## Home stays private

For an agent, `home` is the centre of the ~1 km grid cell home lies in, and every distance
from home (and every Apple search "near home") is measured from that point. That is the
guarantee: an agent can learn the cell, never where in it (up to ~700 m from the centre).
km/miles from home are also rounded to 0.5, which is cosmetic. `find_nearby` / `roll` from
`origin=home` leave spot coordinates out of their answers.
`worker/agents/home.test.ts` trilaterates from three known spots: ~800 m off for an agent
(52 m on the person's own precise view). More in [security.md](security.md#home).

## Brakes

- `AGENT_LIMITER`: 120 requests/min per credential.
- `OAUTH_LIMITER`: 30/min per IP on `/authorize` and `/oauth/*`.
- `BEARER_FAIL_LIMITER`: 20 bad tokens/min per IP, past which that IP's tokens aren't looked
  up for a minute (and a malformed token never reaches KV).
- Dynamic client registration: 5 per IP and 50 in all per day (`daily_counts`; a slot is
  given back if the provider refuses the registration). Consent pages: 20 per person per
  day.
- Plus the ordinary write and search limiters.

The KV cost of all this is in [operations.md](operations.md#kv-budget).
