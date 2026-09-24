-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 015_login_funnel_events
--
-- Steam-login funnel instrumentation (CTA click -> completed login), so the
-- 1-in-300 sign-in rate is measurable instead of anecdotal. One row per
-- funnel event; conversion is derived per anonymous session at read time
-- (getLoginFunnelStats), never stored.
--
-- Privacy notes (deliberate):
-- - session_id is a random browser UUID (localStorage), NOT a Steam ID —
--   the funnel stays anonymous; no user table, no join to accounts.
-- - search_id is nullable (no CTA/search correlation when the click happens
--   outside a search) and carries NO foreign key: the beacon is best-effort
--   and must never fail on an unknown/missing search row.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts), so
-- the statements below never replay. Apply with `pnpm run db:migrate`.
-- =====================================================================

CREATE TABLE IF NOT EXISTS login_funnel_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL CHECK(event IN ('login_cta_clicked', 'login_completed')),
  session_id  TEXT,                                 -- anon browser UUID; NULL when the CTA cookie was absent/unreadable
  search_id   TEXT,                                 -- active search at click time; NULL outside a search
  created_at  TEXT NOT NULL                         -- ISO-8601 timestamp
);
-- Composite (event, session_id) instead of a lone (event): event has only
-- 2 values (near-zero selectivity alone), but the pair makes the panel's
-- intersection subquery (WHERE event='login_cta_clicked' AND session_id
-- IS NOT NULL) index-assisted. session_id alone stays for the smoke
-- script's marker-scoped cleanup DELETEs.
CREATE INDEX IF NOT EXISTS idx_login_funnel_event ON login_funnel_events(event, session_id);
CREATE INDEX IF NOT EXISTS idx_login_funnel_session ON login_funnel_events(session_id);
