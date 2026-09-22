-- =====================================================================
-- Turso (SQLite) schema — Ban Reveal Phase 1 (cheater-review-triggered
-- subscriptions).
-- Migration: 012_ban_watch.sql
--
-- Idempotent via the runner, not via SQL for the ALTER-class parts: the
-- CREATE TABLE / CREATE INDEX statements below use IF NOT EXISTS so a
-- re-run is a safe no-op, but scripts/migrate-db.ts tracks applied files
-- in _migrations and never replays them (that table is the idempotency
-- mechanism here).
-- NEVER RENAME this file after it has been applied anywhere: the runner
-- keys on filename, so a rename replays the statements (real incident
-- with 007, which was applied as 006_watch_anti_loop_token.sql and then
-- renamed). Apply with `pnpm run db:migrate`.
--
-- Design notes (Ban Reveal Phase 1):
-- - Direction is the OPPOSITE of watched_profiles: watched_profiles
--   answers "notify the OWNER of this profile when someone searches
--   them"; ban_watch answers "notify the PERSON WHO REVIEWED this
--   profile when it later gets banned". Subscriber and target are
--   different people — never derive one set from the other table.
-- - Two tables because the cardinalities differ: the sweep checks one
--   row per DISTINCT target (batched GetPlayerBans, max 100 IDs/call),
--   while the fan-out notifies N subscribers per transitioned target.
-- - ban_watch_targets.source is forward-compat only ('steam' is the only
--   value Phase 1 reads/writes; a future FACEIT/Gamersclub sweep reuses
--   the PK without a breaking migration). Phase 1 predicates every read
--   and write on source = 'steam'.
-- - ban_watch_subscriptions has deliberately NO hard FK to
--   ban_watch_targets (same no-FK style as watch_events): an admin
--   deleting a target row must not cascade-delete subscriber history.
-- - notified_at is per-subscription (single ban episode): a future second
--   source would need per-source gating revisited — explicitly out of
--   scope here. A true->false (unban) transition flips the target flag
--   only and NEVER clears notified_at (no re-alert on flap without an
--   explicit product decision).
-- - ban_watch_reveals is instrumentation for a future monetization
--   decision (who clicked through), not a feature gate: append-only, no
--   UNIQUE, no read path in Phase 1 beyond the insert itself.
-- - DEPLOY ORDER (load-bearing): the code shipping with this migration
--   SELECTs/INSERTs these tables (recordAnalyticsCheater hook, sweep,
--   inbox, reveal route). Deploying that code BEFORE running this
--   migration turns every one of those reads into a loud "run
--   db:migrate" failure (the withSchemaHint contract). Run
--   `pnpm run db:migrate` as the FIRST deploy step, same contract as
--   every migration here.
-- =====================================================================

-- One row per distinct (profile, source) ever checked by the sweep.
CREATE TABLE IF NOT EXISTS ban_watch_targets (
  target_steam_id     TEXT NOT NULL,   -- SteamID64 (/^\d{17}$/, enforced in DAL)
  source              TEXT NOT NULL DEFAULT 'steam', -- forward-compat only
  last_known_banned   INTEGER NOT NULL DEFAULT 0,    -- 0/1 boolean
  last_ban_checked_at TEXT,            -- ISO-8601, NULL until first sweep sighting
  PRIMARY KEY (target_steam_id, source)
);

-- N:N subscriber x target profile (not per-source in Phase 1).
CREATE TABLE IF NOT EXISTS ban_watch_subscriptions (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_steam_id TEXT NOT NULL,   -- logged-in user who opened the cheater report
  target_steam_id     TEXT NOT NULL,   -- FK-by-convention to ban_watch_targets, no hard FK
  search_id           TEXT,            -- originating search, nullable, audit trail only
  subscribed_at       TEXT NOT NULL,   -- ISO-8601
  notified_at         TEXT,            -- set once an alert fires for the CURRENT ban
                                       -- episode; also set at subscribe time when the
                                       -- target was already banned (never alert on a
                                       -- pre-existing ban)
  UNIQUE (subscriber_steam_id, target_steam_id)
);

-- Per-target subscriber lookup for the fan-out (one indexed read per
-- transitioned target, regardless of subscriber count).
CREATE INDEX IF NOT EXISTS idx_ban_subs_target_notified
  ON ban_watch_subscriptions(target_steam_id, notified_at);

-- Per-subscriber inbox read (newest notified first).
CREATE INDEX IF NOT EXISTS idx_ban_subs_subscriber_notified
  ON ban_watch_subscriptions(subscriber_steam_id, notified_at);

-- Append-only reveal-click log (instrumentation, not a gate).
CREATE TABLE IF NOT EXISTS ban_watch_reveals (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_steam_id TEXT NOT NULL,
  target_steam_id     TEXT NOT NULL,
  clicked_at          TEXT NOT NULL    -- ISO-8601
);

CREATE INDEX IF NOT EXISTS idx_ban_reveals_subscriber
  ON ban_watch_reveals(subscriber_steam_id, clicked_at);

-- =====================================================================
-- ROLLBACK (manual only — READ THIS BEFORE COPYING ANYTHING OUT).
--
-- The migrate runner (scripts/migrate-db.ts) executes EVERY file matching
-- NNN_*.sql as a FORWARD migration, so a down script must NEVER live in a
-- separate file in this directory: it would be applied as a forward
-- migration and DROP THE TABLES. The rollback lives here, commented out,
-- as documentation for a human running it by hand (sqlite3 / Turso shell):
--
--   DROP TABLE IF EXISTS ban_watch_reveals;
--   DROP TABLE IF EXISTS ban_watch_subscriptions;
--   DROP TABLE IF EXISTS ban_watch_targets;
--   DELETE FROM _migrations WHERE filename = '012_ban_watch.sql';
--
-- Note this destroys subscription + reveal history (opt-in state is not
-- recoverable afterwards). There is no partial-down path by design: the
-- three tables form one Phase-1 unit.
-- =====================================================================
