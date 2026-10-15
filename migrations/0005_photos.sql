-- grub radar: photos on your spots. Forward-only; see README "Database".
-- Additive only: one new table and its indexes. Nothing in 0001-0004's tables changes,
-- so it is safe on a database that already has users, spots and friends.
--
-- The bytes live in R2 (bucket grub-radar-photos, binding PHOTOS) under
-- u/<user_id>/<place_id>/<photo id>, so everything of one person's can also be
-- found by prefix. This table is the index and the source of truth for who can
-- see what: a photo is served only to its owner, or to a friend of the owner
-- while the owner's entry for that place is shared with friends.
--
-- A photo belongs to an entry on your list (user_places), but there's no
-- foreign key to user_places: a future rebuild of that table (as in 0003) would
-- cascade through it and silently drop every photo. Removing a spot deletes its
-- photos explicitly, in the same batch (worker/db/spots.ts). Deleting the user
-- or the place cascades here.

CREATE TABLE photos (
  id           TEXT PRIMARY KEY,             -- 'ph_' + ULID
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id     TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  r2_key       TEXT NOT NULL UNIQUE,         -- 'u/<user_id>/<place_id>/<id>'
  content_type TEXT NOT NULL CHECK (content_type IN ('image/webp','image/jpeg')),
  width        INTEGER NOT NULL CHECK (width BETWEEN 1 AND 1600),
  height       INTEGER NOT NULL CHECK (height BETWEEN 1 AND 1600),
  bytes        INTEGER NOT NULL CHECK (bytes BETWEEN 1 AND 1048576),
  caption      TEXT CHECK (caption IS NULL OR length(caption) BETWEEN 1 AND 140),
  created_at   TEXT NOT NULL
);
-- your photos of one spot (the 6-per-spot cap, the place page) and all of yours (the 200 MB cap)
CREATE INDEX photos_user_place ON photos(user_id, place_id, created_at);
-- friends' photos of a place; ON DELETE CASCADE from places
CREATE INDEX photos_place ON photos(place_id);
