-- grub radar: single-use Sign in with Apple states. Forward-only; see README "Database".
-- Additive only: one new table and its index. Nothing in 0001-0005's tables changes.
--
-- The `state` Apple echoes back is sealed and self-authenticating (worker/auth/siwa.ts),
-- so a browser that drops the state cookie can still sign in. What the cookie used to
-- guarantee on its own, single use, lives here: POST /auth/callback with a code inserts the
-- state's random jti, and a second insert of the same jti (a replay) is refused. Apple's
-- `error` path writes nothing. A state is only valid for 10 minutes, so a row is useless
-- after `expires_at`; each insert deletes the expired rows in the same batch, and the
-- hourly cron sweeps too, keeping the table at a few rows.
CREATE TABLE auth_states_used (
  jti        TEXT PRIMARY KEY,   -- random 16-byte id from inside the sealed state, not secret
  expires_at TEXT NOT NULL       -- ISO-8601: the state's iat + 10 min (+1 min clock slack)
);
CREATE INDEX auth_states_used_expires ON auth_states_used(expires_at);
