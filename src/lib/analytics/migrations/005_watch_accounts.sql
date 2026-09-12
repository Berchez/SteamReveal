-- =====================================================================
-- Turso (SQLite) schema — Watch accounts + signup confirmation (navbar
-- global + confirmação via link do bot).
-- Migration: 005_watch_accounts
--
-- Idempotent: every statement uses IF NOT EXISTS, so re-running this
-- file is a safe no-op. Apply with `pnpm run db:migrate`.
--
-- Design notes:
-- - accounts is a ROOT entity like watched_profiles (no FK parent): one
--   row per Steam profile that signed up, keyed by the verified session
--   SteamID64. It answers "who has an account + is it confirmed", while
--   watched_profiles answers "is there an active watch".
-- - Confirmation rides on NULLABLE token columns, not a second table:
--   exactly one pending token can exist per account (a re-issue
--   overwrites), and consuming it NULLs the columns back out, so "no
--   token row" and "already consumed" are the same observable state.
-- - Only the SHA-256 hex of the token is stored — never the token itself.
--   A DB dump / log line containing the hash cannot be replayed into the
--   confirm endpoint (which hashes its input before comparing).
-- - Expiry is a persisted ISO timestamp compared in SQL (not process
--   time read-then-compared), so clock and check cannot drift apart.
-- =====================================================================

-- One row per signed-up Steam profile.
CREATE TABLE IF NOT EXISTS accounts (
  steam_id           TEXT PRIMARY KEY,   -- SteamID64 (/^\d{17}$/, enforced in DAL)
  created_at         TEXT NOT NULL,      -- ISO-8601 timestamp of signup
  confirmed_at       TEXT,               -- set when the bot-link is clicked; NULL = pending confirmation
  confirm_token_hash TEXT,               -- SHA-256 hex of the pending token; NULL when none outstanding
  confirm_expires_at TEXT,               -- ISO-8601 expiry of the pending token; NULL when none outstanding
  locale             TEXT                -- signup requester locale for bot messages, NULL when unknown
);

-- Lookup for the confirm endpoint is always by token hash.
CREATE INDEX IF NOT EXISTS idx_accounts_confirm_token ON accounts(confirm_token_hash);

-- =====================================================================
-- ROLLBACK (manual only — READ THIS BEFORE COPYING ANYTHING OUT).
--
-- The migrate runner (scripts/migrate-db.ts) executes EVERY file matching
-- NNN_*.sql as a FORWARD migration, so a down script must NEVER live in a
-- separate file in this directory: it would be applied as a forward
-- migration and DROP THE TABLE. The rollback lives here, commented out,
-- as documentation for a human running it by hand (sqlite3 / Turso shell):
--
--   DROP TABLE IF EXISTS accounts;
--   DELETE FROM _migrations WHERE filename = '005_watch_accounts.sql';
--
-- Note this destroys account + confirmation state (only re-signup
-- recovers it). watch_events history survives (no FK either way).
-- =====================================================================
