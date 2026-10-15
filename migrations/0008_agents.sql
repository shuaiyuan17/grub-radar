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

-- Dynamic client registrations per UTC day: each one costs a KV write, and anyone may
-- register, so the Worker refuses past a daily cap (worker/agents/oauth.ts).
CREATE TABLE oauth_registrations (
  day   TEXT PRIMARY KEY,                    -- 'YYYY-MM-DD' (UTC)
  count INTEGER NOT NULL
);
