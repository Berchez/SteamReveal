-- =====================================================================
-- Turso (SQLite) schema — Anti-loop token for Watch notifications.
-- Migration: 007_watch_anti_loop_token.sql
--
-- Idempotent via the runner, not via SQL: SQLite has no
-- ALTER TABLE ... IF NOT EXISTS, so re-running the bare ALTERs errors.
-- scripts/migrate-db.ts tracks applied files in _migrations and never
-- replays them (that table is the idempotency mechanism here).
-- Apply with `pnpm run db:migrate`.
--
-- Design notes:
-- - Tokens are 256-bit random, SHA-256 hashed at rest (64 hex chars).
-- - Partial unique index on hash where hash IS NOT NULL ensures
--   single outstanding token per profile.
-- - TTL enforced at application layer (24h default), expiry stored.
-- - Atomic consume via UPDATE...RETURNING prevents double-use.
-- =====================================================================

-- Add anti-loop token columns to watched_profiles
-- (see idempotency note above: safe to run once via the runner).
ALTER TABLE watched_profiles ADD COLUMN anti_loop_token_hash TEXT;
ALTER TABLE watched_profiles ADD COLUMN anti_loop_expires_at TEXT;

-- Unique index on token hash (only for non-NULL values)
-- Ensures single outstanding token per profile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_watched_profiles_anti_loop_token
  ON watched_profiles(anti_loop_token_hash)
  WHERE anti_loop_token_hash IS NOT NULL;

-- =====================================================================
-- ROLLBACK (manual only — READ THIS BEFORE COPYING ANYTHING OUT).
--
-- The migrate runner (scripts/migrate-db.ts) executes EVERY file matching
-- NNN_*.sql as a FORWARD migration, so a down script must NEVER live in a
-- separate file in this directory: it would be applied as a forward
-- migration and DROP THE COLUMNS. The rollback lives here, commented out,
-- as documentation for a human running it by hand (sqlite3 / Turso shell):
--
--   DROP INDEX IF EXISTS idx_watched_profiles_anti_loop_token;
--   ALTER TABLE watched_profiles DROP COLUMN anti_loop_token_hash;
--   ALTER TABLE watched_profiles DROP COLUMN anti_loop_expires_at;
--   DELETE FROM _migrations WHERE filename = '007_watch_anti_loop_token.sql';
-- =====================================================================
