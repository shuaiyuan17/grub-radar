-- grub radar: the agent door. Forward-only; see README "Database".
-- Additive only: two new tables. OAuth clients, grants and tokens are not here: they live in
-- the OAUTH_KV namespace, managed (hashed, encrypted) by workers-oauth-provider.

-- Personal API tokens, for agents that can't do OAuth (a bot calling the REST API).
-- The token ('grub_pat_' + 32 random bytes, base64url) is shown once and never stored:
-- only its SHA-256. Revoking deletes the row.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,             -- 'pat_' + ULID: names the token for listing/revoking
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,                -- 'grok bot'; also the "found by" on spots it adds
  token_hash   TEXT NOT NULL UNIQUE,         -- SHA-256 (hex) of the token
  scopes       TEXT NOT NULL,                -- space-separated: 'spots:read spots:write'
  created_at   TEXT NOT NULL,
  last_used_at TEXT                          -- bumped at most hourly
);
CREATE INDEX api_tokens_user ON api_tokens(user_id);

-- When each OAuth grant (a connected agent) was last used. KV has a 1,000 writes/day budget,
-- so this lives in D1 and is bumped at most hourly per grant. A row may outlive its grant
-- (revoked or expired in KV); the settings page only shows grants KV still has.
CREATE TABLE agent_grants_seen (
  grant_id     TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_used_at TEXT NOT NULL
);
CREATE INDEX agent_grants_seen_user ON agent_grants_seen(user_id);

-- Disconnected agents (OAuth grants), strongly consistent. Revoking deletes the grant from
-- KV too, but KV is eventually consistent: another edge may still read the old token record
-- for up to a minute. Every OAuth bearer is checked against this table, so a disconnected
-- agent is refused everywhere at once. Written before the KV delete.
CREATE TABLE agent_grants_revoked (
  grant_id   TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  revoked_at TEXT NOT NULL
);

-- Per-day counters for things that cost KV writes and that anyone (or any signed-in person)
-- can trigger: 'register' (all dynamic client registrations), 'register:<ip>' (per IP),
-- 'consent:<user_id>' (consent pages opened). The Worker refuses past a cap.
CREATE TABLE daily_counts (
  key   TEXT NOT NULL,
  day   TEXT NOT NULL,                       -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL,
  PRIMARY KEY (key, day)
);
