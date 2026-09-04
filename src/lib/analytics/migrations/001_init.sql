-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 001_init
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this
-- file is a safe no-op. Apply with `pnpm run db:migrate`.
--
-- This replaces the old file-backed datastore
-- (src/proxy-local/utils/analytics-data.json). The `SearchRecord[]`
-- array from that file maps 1:1 onto these relations: a `searches` row
-- per record, plus child rows for its friends / games / location
-- guesses / cheater result. `searches.id` stays the same string id so
-- the frontend's `searchId` (used to attach the cheater result) keeps
-- working untouched.
-- =====================================================================

-- Root entity: one row per finished search.
CREATE TABLE IF NOT EXISTS searches (
  id          TEXT PRIMARY KEY,                     -- SearchRecord.id (string, e.g. "1699999999999-abc123")
  searched_at TEXT NOT NULL                         -- ISO-8601 timestamp
);

-- 1:1 — the profile that was searched (the target of the analysis).
CREATE TABLE IF NOT EXISTS profiles (
  search_id    TEXT PRIMARY KEY REFERENCES searches(id) ON DELETE CASCADE,
  steam_id     TEXT NOT NULL,
  steam_url    TEXT,
  nickname     TEXT,
  gc_name      TEXT,
  country_code TEXT,
  state_code   TEXT,
  city_id      TEXT,                                 -- numeric in JSON; stored as TEXT to match ProfileRecord.cityId type
  is_cs_active INTEGER,                             -- SQLite boolean: 0/1/NULL
  duration_ms  INTEGER                              -- wall-clock search time (ms); lives here 1:1 with profile, not in searches
);

-- 1:1 — metadata about the visitor who ran the search, not the target.
CREATE TABLE IF NOT EXISTS search_meta (
  search_id                 TEXT PRIMARY KEY REFERENCES searches(id) ON DELETE CASCADE,
  requester_locale          TEXT,
  requester_country         TEXT,
  requester_browser_language TEXT,
  device                    TEXT                     -- 'mobile' | 'desktop' | NULL
);

-- N:1 — close-friends found on the search.
CREATE TABLE IF NOT EXISTS friends (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id   TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  steam_id    TEXT NOT NULL,
  nickname    TEXT,
  gc_name     TEXT,
  mutual_count INTEGER,                              -- raw "close friend" score
  probability REAL,                                  -- 0-100 computed probability
  country_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_friends_search_id ON friends(search_id);

-- N:1 — most-played games snapshot at search time.
CREATE TABLE IF NOT EXISTS games_snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id      TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  playtime_hours REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_games_snapshot_search_id ON games_snapshot(search_id);

-- N:1 — top predicted locations for the searched profile.
-- `location` stores a JSON-serialized object: {"cityName","stateName","countryName","countryCode"}.
-- On read, JSON.parse() it back to LocationGuess.location. On write, JSON.stringify() the object.
CREATE TABLE IF NOT EXISTS location_guesses (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  search_id   TEXT NOT NULL REFERENCES searches(id) ON DELETE CASCADE,
  location    TEXT NOT NULL,
  probability REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_location_guesses_search_id ON location_guesses(search_id);

-- 0..1 — cheater-probability result, attached later via
-- attachCheaterProbability(). search_id is the PK so re-attaching the
-- same search simply upserts instead of creating duplicates.
CREATE TABLE IF NOT EXISTS cheater_results (
  search_id            TEXT PRIMARY KEY REFERENCES searches(id) ON DELETE CASCADE,
  score                REAL NOT NULL,
  banned_friends_count INTEGER,
  computed_at          TEXT NOT NULL                 -- ISO-8601 timestamp
);