-- grub radar: an unknown price, and a good/meh/bad verdict instead of a 1-10 rating.
-- Forward-only; see README "Database".
--
-- 1. user_places.price becomes nullable, NULL = unknown, no default. It used to be
--    NOT NULL DEFAULT '$$', and every add from Apple Maps (which has no price) got
--    '$$': a guess shown as a fact.
-- 2. user_places.rating (INTEGER 1-10) becomes verdict ('good' | 'meh' | 'bad' | NULL),
--    and so does visits.rating: each visit keeps its own verdict.
--    8-10 -> good, 5-7 -> meh, 1-4 -> bad.
--
-- SQLite can't change a column's nullability or CHECK in place, so both tables are
-- rebuilt: create the new shape, copy every row across (mapping as we go), drop the
-- old table, rename the new one, recreate its indexes. Nothing references
-- user_places or visits by foreign key, so dropping them cascades nowhere; their own
-- references (users, places) are declared again on the new tables. D1 runs a
-- migration file as one transaction: if any statement fails, none of it applies.

CREATE TABLE user_places_new (
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id     TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL CHECK (kind IN ('food','coffee','bakery')),
  cuisine      TEXT NOT NULL DEFAULT '',     -- '' = unknown
  price        TEXT CHECK (price IN ('$','$$','$$$','$$$$')),   -- NULL = unknown
  icon         TEXT NOT NULL DEFAULT 'bowl',
  hours_json   TEXT,                         -- Spot.hours as JSON: {"closes":"22:00","days":["fri"]}
  status       TEXT NOT NULL CHECK (status IN ('been','want')),
  verdict      TEXT CHECK (verdict IN ('good','meh','bad')),    -- NULL = no verdict
  note         TEXT NOT NULL DEFAULT '',     -- the ≤60-char handwritten one-liner
  my_note      TEXT,                         -- longer; add_note appends "— YYYY-MM-DD: …" lines
  order_json   TEXT NOT NULL DEFAULT '[]',   -- [{"id":"d1","dish":"…","tried":false}]
  tags_json    TEXT NOT NULL DEFAULT '[]',   -- per-user craving tags (chips)
  why_text     TEXT,
  why_found_on TEXT,                         -- ISO date
  lang         TEXT,                         -- language your text is in: NULL (en) | 'zh-Hans'
  found_by     TEXT NOT NULL DEFAULT 'me',   -- 'me' | agent client name (PR 5) | 'friend:<user_id>' (v2)
  visibility   TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('friends','private')),
  version      INTEGER NOT NULL DEFAULT 1,   -- +1 on every write; edits are guarded by it (409 on mismatch)
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (user_id, place_id),
  CHECK (verdict IS NULL OR status = 'been')
);

INSERT INTO user_places_new (
  user_id, place_id, kind, cuisine, price, icon, hours_json, status, verdict, note, my_note,
  order_json, tags_json, why_text, why_found_on, lang, found_by, visibility, version,
  created_at, updated_at
)
SELECT
  up.user_id, up.place_id, up.kind, up.cuisine,
  -- The old '$$' default on a spot added from Apple Maps and never written since
  -- (version 1: every write, edits, mark_been and add_note included, bumps it) was
  -- never anyone's answer: it becomes unknown. A '$$' typed by hand, or on any row
  -- that has been edited, is kept. (version is left as it is: this is a correction,
  -- not an edit, and must not make the app's open copies 409.)
  CASE
    WHEN up.price = '$$' AND up.version = 1
      AND EXISTS (SELECT 1 FROM places p WHERE p.id = up.place_id AND p.apple_place_id IS NOT NULL)
    THEN NULL
    ELSE up.price
  END,
  up.icon, up.hours_json, up.status,
  CASE
    WHEN up.rating IS NULL THEN NULL
    WHEN up.rating >= 8 THEN 'good'
    WHEN up.rating >= 5 THEN 'meh'
    ELSE 'bad'
  END,
  up.note, up.my_note, up.order_json, up.tags_json, up.why_text, up.why_found_on, up.lang,
  up.found_by, up.visibility, up.version, up.created_at, up.updated_at
FROM user_places up;

DROP TABLE user_places;
ALTER TABLE user_places_new RENAME TO user_places;
CREATE INDEX user_places_place ON user_places(place_id);

CREATE TABLE visits_new (
  id         TEXT PRIMARY KEY,               -- 'v_' + ULID
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  place_id   TEXT NOT NULL REFERENCES places(id) ON DELETE CASCADE,
  visited_on TEXT NOT NULL,                  -- ISO date
  verdict    TEXT CHECK (verdict IN ('good','meh','bad')),
  note       TEXT,
  created_at TEXT NOT NULL
);

INSERT INTO visits_new (id, user_id, place_id, visited_on, verdict, note, created_at)
SELECT
  id, user_id, place_id, visited_on,
  CASE
    WHEN rating IS NULL THEN NULL
    WHEN rating >= 8 THEN 'good'
    WHEN rating >= 5 THEN 'meh'
    ELSE 'bad'
  END,
  note, created_at
FROM visits;

DROP TABLE visits;
ALTER TABLE visits_new RENAME TO visits;
CREATE INDEX visits_user_place ON visits(user_id, place_id);
CREATE INDEX visits_place ON visits(place_id);
