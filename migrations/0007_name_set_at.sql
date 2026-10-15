-- grub radar: has this person chosen the name friends see? Forward-only; see README "Database".
-- Additive only: one nullable column on users, plus a backfill. Nothing else changes.
--
-- Apple sends a name only on an Apple ID's first authorization of the app, and not at all
-- when the person hides it. When that first sign-in doesn't stick (or the name is hidden)
-- the account gets the stand-in name 'you' (DEFAULT_DISPLAY_NAME), which is what friends
-- then saw. `name_set_at` is when a real name arrived: from Apple at sign-up, or saved by
-- the person (PATCH /api/me with a displayName). NULL: not chosen yet; the app asks before
-- anything else, and friends, invite pages and the admin page show a neutral placeholder.
ALTER TABLE users ADD COLUMN name_set_at TEXT;   -- ISO-8601, or NULL while unchosen

-- Backfill: anyone not called 'you' got a name from Apple or picked one; date it from
-- sign-up. Anyone still called 'you' never chose, and stays NULL.
UPDATE users SET name_set_at = created_at WHERE display_name <> 'you';
