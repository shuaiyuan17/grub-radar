# Auth: Sign in with Apple, sessions, CSRF

People sign in with Apple; there are no passwords and no other providers. Agents use bearer
tokens instead: see [agents.md](agents.md). The security invariants are summarised in
[security.md](security.md); endpoints are in [api.md](api.md).

## Sign in with Apple

Code: `worker/auth/siwa.ts`, `worker/auth/pending.ts`, `worker/auth/appleKeys.ts`,
`worker/routes/auth.ts`. It's the web flow with `response_type=code` and
`response_mode=form_post`.

### The state

`GET /auth/apple/start?returnTo=/same/origin/path` sends the browser to Apple. The `state` we
send is itself the payload (a random `jti`, the nonce's hash, `returnTo`, the previous
session id, issued-at), AES-GCM-sealed with a key derived from `SESSION_HMAC_KEY`:
self-authenticating, opaque (the previous session id never shows in a URL), ~300
characters, valid 10 minutes. Apple echoes it back verbatim.

The same value is also set in a `__Host-grub_siwa` cookie (`SameSite=None`, because Apple's
callback is a cross-site POST). When the browser sends that cookie back, it must equal the
posted state (path `cookie`).

### The cookie-less fallback, and its trade-off

Some browsers don't send the state cookie back (seen from iPhones in practice: an in-app
browser handing Apple's page to another one, or cross-site cookies blocked). Then a valid
sealed state alone is accepted (path `signed-state-only`).

**Accepted trade-off:** on that path nothing binds the callback to the browser that started,
so login CSRF is possible: an attacker who gets their own fresh, unused code + state POSTed
from a victim's browser within 10 minutes could sign the victim in to the attacker's
account. It's narrowed:

- Such a sign-in never replaces a live session. `/auth/finish` is a same-origin POST, so it
  sees the Lax session cookie, and if that session is live it exchanges nothing, keeps the
  session and sends the browser home with "you're already signed in" (`?signin=already`).
- What's left is a signed-out victim being signed in to the attacker's account: low impact
  (they see the attacker's list; nothing of theirs is exposed or changed).
- A browser that does send the cookie keeps the binding (a mismatch is refused).
- The timing log's `siwa_state` field shows how often each path happens
  ([operations.md](operations.md#timing-and-logs)).

### Single use

A state that comes back with a code is single use: the callback records its `jti` in D1
(`auth_states_used`, migration 0006), so a replay is refused, and the id_token's nonce must
match the sealed hash. Apple's `error` (cancel) is checked against the state too, but writes
nothing, so unauthenticated posts can't grow the table and a leaked state can't be burned by
a fake error. Expired rows are swept with each spend and by the hourly cron.

### The callback and the hand-off

`POST /auth/callback` (Apple's form_post) is braked per client IP (`CALLBACK_LIMITER`,
30/min). It checks the state (before looking at Apple's `error`), spends it when there's a
code (one D1 round trip), and answers at once with a tiny "signing you in…" page (en/中文).
`GET /auth/callback` just redirects to `/`: it's never Apple (iOS preloads it, or it's the
back button).

The page's one-line inline script (allowed by CSP hash, like its CSS) submits a same-origin
POST form to `/auth/finish` with the hand-off value `t` in the body, never in a URL; a
"continue" button is the no-JS fallback.

What crosses over (code, nonce hash, `returnTo`, previous session, Apple's one-time `user`
field) is AES-GCM-sealed in a two-minute `__Host-grub_signin` cookie (HttpOnly, Secure, Lax)
bound to that random `t`. It's set on our answer to Apple's POST (a first-party response)
and read on our own page's same-origin POST, so it survives the browsers that drop the state
cookie; `e2e/auth.spec.ts` checks that.

`POST /auth/finish` refuses (and leaves alone) anything without the matching `t`, or not
`Sec-Fetch-Site: same-origin` (without that header: an `Origin` equal to `PUBLIC_ORIGIN`;
neither is a no). A `GET` there just goes home, and the cookie is cleared on first use. It
then:

1. exchanges the code with a fresh 5-minute ES256 client secret **while** loading Apple's
   JWKS,
2. verifies the id_token (RS256; `iss`, `aud`, `exp`, nonce),
3. finds or creates the user by Apple `sub` and starts the session, in one D1 batch.

### Names

Apple sends the person's name only on the first authorization; it's stored then, and counts
as chosen (`users.name_set_at`). Without one (a retried first sign-in, or a hidden name) the
account gets the stand-in `'you'`, `GET /api/me` says `nameSet: false`, and the app asks
"what should we call you?" before anything else (a blocking dialog; an invite link the tab is
holding carries on after). Saving a name through `PATCH /api/me` chooses it. Until then
nobody else sees the stand-in: every read of someone else's name (friends, takes, invite
previews, admin) selects `NULL` for an unchosen name, in SQL, and the app shows "a friend".

### Apple's keys

The JWKS is kept in isolate memory and the Cache API (`worker/auth/appleKeys.ts`): Apple's
`max-age` if it sends one (clamped 5 min–24 h); it sends `no-store` today, so an hour. An
unknown `kid` or a failing signature refetches once (even when the set came straight from
Apple), at most once a minute.

## Sessions

`worker/auth/session.ts`. A random 32-byte token in `__Host-grub_session` (HttpOnly, Secure,
SameSite=Lax, 30 days sliding, never more than 90 days after sign-in; the cookie is re-issued
once fewer than 15 days remain). D1 stores only its SHA-256. Signing in again ends the
browser's previous session.

A lookup is one D1 round trip: the session row joined with its user, plus the route's own
reads for the two hot GETs (`/api/me`, `/api/spots`) in the same batch, scoped in SQL to that
live session. The sliding-expiry / hourly `last_seen_at` write happens only when due, after
the response (`waitUntil`). Logout (`POST /auth/logout`) is a single `DELETE` by the cookie's
hash. `worker/routes/roundtrips.test.ts` pins the round trips per request (see
[operations.md](operations.md#timing-and-logs)).

Read replication stays off because of sessions: see [data.md](data.md#read-replication).

## CSRF

`worker/auth/csrf.ts`, defence in depth on top of SameSite=Lax. A state-changing request
authenticated by cookie needs:

- `Content-Type: application/json` (photo uploads: the image types),
- `X-Grub-Request: 1` (a cross-origin page can't add it without a CORS preflight, and we
  never answer preflights),
- a same-origin `Sec-Fetch-Site` (`same-origin` or `none`), or, when the browser doesn't send
  that, an `Origin` equal to ours when present.

There are no CORS headers anywhere. A request whose _resolved principal_ is an agent (a valid
bearer token) needs only the right content type: a bearer token isn't ambient. A mere
`Authorization` header proves nothing, so it doesn't count. The check runs after the
principal is resolved ([agents.md](agents.md#principals)).

## Who can sign up

`SIGNUP_OPEN` in `wrangler.jsonc`. `"true"` (the current setting): any Apple ID. `"false"`:
closed; others see "invite-only". While closed, exactly one account can still be created: if
the `OWNER_APPLE_SUB` secret is set, only that Apple ID; if not, only the very first account.
Admission is decided inside the `INSERT` (one D1 transaction with the identity row), so
simultaneous first sign-ins can't both get in. To pin the owner, read their `sub`
(`wrangler d1 execute DB --remote --command "SELECT provider_sub FROM auth_identities"`) and
`wrangler secret put OWNER_APPLE_SUB`.

## Admin

`worker/routes/admin.ts`. `/admin` shows total users, sign-ups per day for 30 days, and per
person: name, joined, last seen (newest session activity, never before the last sign-in),
spots and friends. No emails, Apple subs or ids.

Admins are the Apple `sub`s in the `ADMIN_APPLE_SUBS` secret (comma-separated; unset =
nobody), matched against the caller's Apple identity. To anyone else `/api/admin/*` answers,
for any method, exactly what an unknown endpoint does, and `/admin` renders the ordinary
not-found page (the SPA shell is the same for every unknown URL, so the page's existence
doesn't show; its code and strings are a lazily loaded chunk, not in the main bundle). To set
it: read the owner's `sub` (the query above), then `wrangler secret put ADMIN_APPLE_SUBS`.
Locally, `.dev.vars` names the dev user signed in with `POST /auth/dev-login {"as":"admin"}`.

## Local development

Apple only returns people to the production origin, so locally "Sign in with Apple" goes to a
stub (`npm run apple-stub`, `e2e/apple-stub.ts`; `APPLE_ENDPOINT_BASE` in `.dev.vars`), where
you pick any name and continue. Playwright signs in with `POST /auth/dev-login`, which needs
`ENVIRONMENT=development`, a localhost request and `DEV_LOGIN_SECRET`.

**Dev-only behaviour** (dev login, the Apple stub, request-origin redirects, the demo import)
needs `ENVIRONMENT=development` exactly; any other value behaves like production.
