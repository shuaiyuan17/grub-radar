-- grub radar: photos on your spots. Forward-only; see README "Database".
-- Additive only: two new tables, their indexes and a trigger. Nothing in 0001-0004's tables changes,
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

-- R2 can't join a D1 transaction, so this outbox is the durable list of R2 keys whose
-- bytes may need deleting. Two kinds of row:
--   pending = 1  written by an upload BEFORE it puts the bytes; the same batch that inserts
--                the photo row deletes it. If it's still here, the upload didn't finish
--                (refused, crashed, or D1 failed at the end): once it's old enough that no
--                request can still be working on it, and no photos row has the key, the
--                bytes go.
--   pending = 0  the key of a deleted photo row (the trigger below: one photo, a spot, a
--                place, or a whole account by cascade), or of a refused upload: due now.
-- A sweeper (worker/db/photos.ts sweepPhotoDeletions) never deletes bytes a photos row still
-- points at; it deletes the objects and then the rows: right after the request, and hourly
-- from the cron trigger, with capped retries.
CREATE TABLE photo_deletions (
  r2_key     TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  pending    INTEGER NOT NULL DEFAULT 0 CHECK (pending IN (0, 1)),
  attempts   INTEGER NOT NULL DEFAULT 0     -- failed sweeps so far; the cron gives up at 10
);
CREATE INDEX photo_deletions_due ON photo_deletions(attempts, created_at);

CREATE TRIGGER photos_to_outbox AFTER DELETE ON photos
BEGIN
  INSERT OR REPLACE INTO photo_deletions (r2_key, created_at, pending)
  VALUES (OLD.r2_key, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 0);
END;
