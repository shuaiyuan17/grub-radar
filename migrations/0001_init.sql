-- grub radar: accounts and sessions (PR 1). Forward-only; see README "Database".

CREATE TABLE users (
  id            TEXT PRIMARY KEY,            -- 'u_' + ULID (lowercase base32)
  display_name  TEXT NOT NULL,               -- from Apple `user.name` on first auth, else 'you'
  avatar_emoji  TEXT NOT NULL DEFAULT '🍜',
  friend_code   TEXT UNIQUE,                 -- v2, nullable until used
  created_at    TEXT NOT NULL,
  last_login_at TEXT NOT NULL
);

CREATE TABLE auth_identities (
  provider        TEXT NOT NULL,             -- 'apple'
  provider_sub    TEXT NOT NULL,             -- Apple `sub`: stable per team, shared by Services ID and App ID
  user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email           TEXT,                      -- may be a @privaterelay.appleid.com address
  email_is_relay  INTEGER NOT NULL DEFAULT 0,
  refresh_token   TEXT,                      -- Apple refresh token; only used for /auth/revoke on account deletion
  created_at      TEXT NOT NULL,
  PRIMARY KEY (provider, provider_sub)
);
CREATE INDEX auth_identities_user ON auth_identities(user_id);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,             -- SHA-256 (hex) of the cookie token; the token itself is never stored
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,                -- bumped at most once per hour (D1 write budget)
  ua_hint      TEXT                          -- 'Safari on iPhone', for the "sessions" list
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE INDEX sessions_expires ON sessions(expires_at);

-- Home lives apart from users so no join or SELECT * on users can leak it.
CREATE TABLE user_private (
  user_id    TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  home_lat   REAL,
  home_lng   REAL,
  updated_at TEXT NOT NULL
);
