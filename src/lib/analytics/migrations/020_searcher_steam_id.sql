-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 020_searcher_steam_id
--
-- Tracks WHO ran the search (the logged-in viewer's SteamID64), enabling
-- the per-account "my search history" panel. NULL for anonymous searches
-- and every row predating this column — readers treat NULL as "unknown",
-- history starts at deploy. Privacy: owner-signed expansion beyond the
-- previous coarse-geo-only doctrine (never IP/city/locale/browser);
-- coarse requester_country etc. remain untouched.
--
-- RESHAPED BEFORE FIRST DEPLOY (Oct 2026): the column was first drafted
-- on search_meta, but the history read sorts/filters by (searcher,
-- searched_at, id) — a cross-table predicate that no index can serve
-- (O(N) sort per page). Living on searches, one composite partial index
-- turns paging into an index seek, the COUNT into a range count, and the
-- retention purge into a plain range UPDATE. The _migrations ledger was
-- verified EMPTY (including prod Turso) before the reshape, so no
-- applied database carries the old shape — safe to rewrite the file.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts), so
-- the bare ALTER below never replays. Apply with `pnpm run db:migrate`.
--
-- DEPLOY CONTRACT (migration-first, no exceptions): run db:migrate BEFORE
-- deploying site and bot. Until this lands, recordSearch/removeWatchAndAccount
-- degrade through the 020-pending bridge (warn-once + anonymous writes),
-- but the history reads (GET /api/history), DELETE, purge and dashboard
-- fail LOUD (500 / daily error) by design — a silent empty history would
-- be worse. `pnpm run db:smoke` (pre-push gate) asserts this column and
-- fails the push while it is missing.
-- =====================================================================

ALTER TABLE searches ADD COLUMN searcher_steam_id TEXT;
CREATE INDEX IF NOT EXISTS idx_searches_searcher
  ON searches(searcher_steam_id, searched_at DESC, id DESC)
  WHERE searcher_steam_id IS NOT NULL;
