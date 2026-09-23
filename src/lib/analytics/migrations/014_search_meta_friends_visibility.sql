-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 014_search_meta_friends_visibility
--
-- Tracks HOW the searched profile's friends list resolved, so private-list
-- searches (recorded in degraded mode with zero friend rows) stay
-- distinguishable from genuinely friendless profiles (also zero rows).
-- NULL for legacy rows predating this column — readers treat NULL as
-- "unknown", never as private.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts), so
-- the bare ALTER below never replays. Apply with `pnpm run db:migrate`.
-- =====================================================================

ALTER TABLE search_meta ADD COLUMN friends_visibility TEXT;
