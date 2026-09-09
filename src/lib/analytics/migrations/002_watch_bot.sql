-- =====================================================================
-- Turso (SQLite) schema — Watch Bot (notify user when their profile is
-- searched).
-- Migration: 002_watch_bot
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this
-- file is a safe no-op. Apply with `pnpm run db:migrate`.
--
-- Design notes (Epic: Watch Bot & Notifications):
-- - watched_profiles is a ROOT entity like searches (no FK parent): one
--   row per Steam profile under observation. There is deliberately NO
--   email column anywhere — the bot notifies over Steam chat, and the
--   friendship itself is the opt-in proof.
-- - watch_events is an append-only outbox AND the notification log AND the
--   inbox source (the bell UI reads it): the bot pollers claim queued rows,
--   mark them sent/dropped, and the UI lists them. One table, three jobs.
-- - watch_events has deliberately NO foreign key to watched_profiles:
--   opting out DELETES the watched_profiles row (PII removal), and the
--   event log must survive that. Events carry only the public steam_id
--   (already searchable on the site), never email/locale PII.
-- - Status values are validated in the DAL, not via CHECK constraints,
--   matching the style of 001_init.sql.
-- =====================================================================

-- One row per Steam profile under observation.
CREATE TABLE IF NOT EXISTS watched_profiles (
  steam_id         TEXT PRIMARY KEY,   -- SteamID64 (/^\d{17}$/, enforced in DAL)
  status           TEXT NOT NULL,      -- 'pending' (invite sent, not yet accepted) | 'active'
  locale           TEXT,               -- requester locale for bot messages ('pt' | 'en' | ...), NULL when unknown
  requested_at     TEXT NOT NULL,      -- ISO-8601 timestamp of the watch request
  activated_at     TEXT,               -- set on pending -> active (friendship observed)
  last_notified_at TEXT                -- last successful notify send (Epic 4 cooldown clock)
);

-- Append-only event log + poller outbox. `kind` separates the two poller
-- lanes (invite sender vs notify sender) so concurrent pollers never
-- contend for the same rows.
CREATE TABLE IF NOT EXISTS watch_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- The search that produced a notify event. NULL for invites (which are
  -- not tied to any search). UNIQUE still dedupes: SQLite allows multiple
  -- NULLs but rejects a repeated non-null value — so INSERTing a second
  -- event for the same search fails, which is exactly the "one message per
  -- search, max" idempotency the notify hook (Epic 4) relies on. The DAL
  -- pre-checks instead of parsing that violation (repo convention).
  search_id   TEXT UNIQUE,
  steam_id    TEXT NOT NULL,          -- watched profile this event belongs to
  kind        TEXT NOT NULL,          -- 'invite' | 'notify'
  -- 'queued' (pollable) | 'claimed' (transient: a worker owns it right
  -- now; see resetStaleClaims in the DAL) | 'sent' | 'dropped'.
  status      TEXT NOT NULL,
  created_at  TEXT NOT NULL,          -- ISO-8601 timestamp
  claimed_at  TEXT,                   -- set on claim, cleared on requeue
  sent_at     TEXT                    -- set on sent/dropped
);

-- Poller lane: "my queued rows, oldest first".
CREATE INDEX IF NOT EXISTS idx_watch_events_kind_status ON watch_events(kind, status);
-- Per-profile history (inbox reads + debugging).
CREATE INDEX IF NOT EXISTS idx_watch_events_steam_status ON watch_events(steam_id, status);

-- =====================================================================
-- ROLLBACK (manual only — READ THIS BEFORE COPYING ANYTHING OUT).
--
-- The migrate runner (scripts/migrate-db.ts) executes EVERY file matching
-- NNN_*.sql as a FORWARD migration, so a down script must NEVER live in a
-- separate file in this directory: it would be applied as a forward
-- migration and DROP THE TABLES. The rollback lives here, commented out,
-- as documentation for a human running it by hand (sqlite3 / Turso shell):
--
--   DROP TABLE IF EXISTS watch_events;
--   DROP TABLE IF EXISTS watched_profiles;
--   DELETE FROM _migrations WHERE filename = '002_watch_bot.sql';
--
-- Note this destroys watched rows AND event history (opt-in state is not
-- recoverable afterwards). There is no partial-down path by design: the
-- two tables form one Epic-1 unit.
-- =====================================================================
