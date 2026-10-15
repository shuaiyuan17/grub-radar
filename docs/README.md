# grub radar docs

The technical side of [grub radar](../README.md). For coding agents working in this repo,
[AGENTS.md](../AGENTS.md) has the short version: commands, conventions and rules.

| doc                                | what's in it                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| [architecture.md](architecture.md) | the code layout and its boundaries, views and URLs, travel time, i18n, the hand-drawn look, stack |
| [auth.md](auth.md)                 | Sign in with Apple, the sign-in hand-off, sessions, CSRF, who can sign up, admin                  |
| [agents.md](agents.md)             | the agent door: principals, OAuth 2.1, MCP, personal tokens, scopes, home snapping                |
| [data.md](data.md)                 | D1 tables, places vs your list, concurrency, migrations, friends, photos in R2 and the outbox     |
| [api.md](api.md)                   | every HTTP endpoint and who may call it                                                           |
| [security.md](security.md)         | the invariants (home, friends, photos, CSRF, headers) and the tests that hold them                |
| [operations.md](operations.md)     | running locally, deploys, secrets, rate limits, the KV budget, cron, timing logs                  |
