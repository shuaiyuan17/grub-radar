-- grub radar: places and personal lists (PR 2). Forward-only; see README "Database".
-- Additive only: new tables, nothing in 0001's tables changes, so it is safe on a
-- database that already has users and sessions.

-- A place in the world. Global: Apple places (PR 3) are shared and deduped by
-- apple_place_id. Manual places belong to whoever created them: only that user
-- can edit their name, kind, location, … (enforced in SQL by the repository).
CREATE TABLE places (
  id             TEXT PRIMARY KEY,           -- 'p-' + ULID (fits the SpotSchema id regex); seed slugs in dev
  apple_place_id TEXT UNIQUE,                -- NULL for manual places
  name           TEXT NOT NULL,
  lat            REAL NOT NULL CHECK (lat BETWEEN -90 AND 90),
  lng            REAL NOT NULL CHECK (lng BETWEEN -180 AND 180),
  address        TEXT,
  kind           TEXT NOT NULL CHECK (kind IN ('food','coffee','bakery')),
  cuisine        TEXT NOT NULL DEFAULT '',
  price          TEXT NOT NULL DEFAULT '$$' CHECK (price IN ('$','$$','$$$','$$$$')),
  icon           TEXT NOT NULL DEFAULT 'bowl',
  hours_json     TEXT,                       -- Spot.hours as JSON: {"closes":"22:00","days":["fri"]}
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX places_created_by ON places(created_by);

-- "My list": one row per (user, place). Every read and write is scoped by user_id.
CREATE TABLE user_places (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id     TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('been','want')),
  rating       INTEGER CHECK (rating BETWEEN 1 AND 10),
  note         TEXT NOT NULL DEFAULT '',     -- the ≤60-char handwritten one-liner
  my_note      TEXT,                         -- longer; add_note appends "— YYYY-MM-DD: …" lines
  order_json   TEXT NOT NULL DEFAULT '[]',   -- [{"dish":"…","tried":false}]
  tags_json    TEXT NOT NULL DEFAULT '[]',   -- per-user craving tags (chips)
  why_text     TEXT,
  why_found_on TEXT,                         -- ISO date
  lang         TEXT,                         -- language your text is in: NULL (en) | 'zh-Hans'
  found_by     TEXT NOT NULL DEFAULT 'me',   -- 'me' | agent client name (PR 5) | 'friend:<user_id>' (v2)
  visibility   TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('friends','private')),
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,                -- also the optimistic-concurrency token for edits
  PRIMARY KEY (user_id, place_id),
  CHECK (rating IS NULL OR status = 'been')
);
CREATE INDEX user_places_place ON user_places(place_id);   -- v2: "which friends have been here"

-- Append-only: every mark_been inserts one row.
CREATE TABLE visits (
  id         TEXT PRIMARY KEY,               -- 'v_' + ULID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  visited_on TEXT NOT NULL,                  -- ISO date
  rating     INTEGER CHECK (rating BETWEEN 1 AND 10),
  note       TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX visits_user_place ON visits(user_id, place_id);
