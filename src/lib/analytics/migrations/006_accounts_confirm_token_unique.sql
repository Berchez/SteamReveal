-- =====================================================================
-- Turso (SQLite) schema — unique guard on confirmation token hashes.
-- Migration: 006_accounts_confirm_token_unique
--
-- Idempotent: every statement uses IF (NOT) EXISTS, so re-running this
-- file is a safe no-op. Apply with `pnpm run db:migrate`.
--
-- Design notes:
-- - Tokens are 256-bit random, so a collision is practically impossible —
--   this index is defense in depth against a BUG (e.g. a broken RNG
--   issuing the same token twice), not against brute force. Two accounts
--   sharing one hash would make consumeConfirmToken confirm the WRONG
--   account, so the database refuses the second write loudly instead.
-- - Partial (WHERE confirm_token_hash IS NOT NULL): the overwhelmingly
--   common state is "no token outstanding" (NULL), and NULLs never
--   collide — only real hashes are unique-checked.
-- - Replaces the plain idx_accounts_confirm_token from 005 (dropped
--   here): the unique partial index serves the same by-hash lookups, so
--   keeping both would pay double write amplification for zero reads.
--   Create-then-drop order matters: if a duplicate somehow already
--   exists, the CREATE fails loudly BEFORE the old index is touched.
-- =====================================================================

CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_confirm_token_unique
  ON accounts(confirm_token_hash)
  WHERE confirm_token_hash IS NOT NULL;

DROP INDEX IF EXISTS idx_accounts_confirm_token;

-- =====================================================================
-- ROLLBACK (manual only — READ THIS BEFORE COPYING ANYTHING OUT).
--
-- The migrate runner (scripts/migrate-db.ts) executes EVERY file matching
-- NNN_*.sql as a FORWARD migration, so a down script must NEVER live in a
-- separate file in this directory: it would be applied as a forward
-- migration and DROP THE INDEX. The rollback lives here, commented out,
-- as documentation for a human running it by hand (sqlite3 / Turso shell):
--
--   DROP INDEX IF EXISTS idx_accounts_confirm_token_unique;
--   CREATE INDEX IF NOT EXISTS idx_accounts_confirm_token ON accounts(confirm_token_hash);
--   DELETE FROM _migrations WHERE filename = '006_accounts_confirm_token_unique.sql';
-- =====================================================================
