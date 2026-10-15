-- grub radar: friends, by invite link only (v2 / PR 7). Forward-only; see README "Database".
-- Additive only: two new tables and their indexes. Nothing in 0001-0003's tables changes,
-- so it is safe on a database that already has users, sessions and spots.
--
-- The friend model (owner, 10/15): the only way in is an invite link. Sending a link is
-- consent; whoever opens it, signs in and taps accept becomes a friend of the sender, both
-- ways, at once. No search, no friend codes (users.friend_code from 0001 stays unused:
-- SQLite can't drop a UNIQUE column in place, and an unused NULL column costs nothing),
-- no one-way follow. Either side can unfriend, which ends it for both.

-- A friendship is stored as two rows, (a, b) and (b, a), written and deleted together in
-- one batch, so "my friends" is one indexed lookup on the primary key, either way round.
CREATE TABLE friendships (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, friend_id),
  CHECK (user_id <> friend_id)
);
CREATE INDEX friendships_friend ON friendships(friend_id);   -- ON DELETE CASCADE from users

-- Invite links. The link carries a 32-byte random token; only its SHA-256 is stored, so
-- the table alone can't be turned back into working links. Single use (used_by), expire
-- after 7 days (expires_at), revocable by their creator while unused (revoked_at).
CREATE TABLE invites (
  id         TEXT PRIMARY KEY,               -- 'inv_' + ULID: names the link for revoke/list, not secret
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 (hex) of the link's token
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,   -- who sent it
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by    TEXT REFERENCES users(id) ON DELETE SET NULL,           -- who accepted it
  used_at    TEXT,
  claim      TEXT,                           -- random per accept attempt: which request claimed it
  revoked_at TEXT,
  CHECK (used_by IS NULL OR used_by <> user_id)
);
CREATE INDEX invites_user ON invites(user_id, created_at);   -- your pending links; 20/day cap
CREATE INDEX invites_used_by ON invites(used_by);            -- ON DELETE SET NULL from users
