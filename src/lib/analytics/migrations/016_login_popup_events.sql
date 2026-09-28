-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 016_login_popup_events
--
-- Login-prompt popup funnel instrumentation (popup shown -> popup CTA
-- click -> attributed signin), so the non-blocking login prompt's effect
-- is measurable instead of anecdotal. One row per popup event; signin
-- attribution is derived per anonymous session at read time
-- (getLoginFunnelStats), never stored.
--
-- Separate table (NOT new events in login_funnel_events): that table's
-- CHECK(event IN (...)) cannot be ALTERed in SQLite — new events there
-- would require a rebuild with data copy and risk the existing funnel
-- data. A fresh table carries zero migration risk.
--
-- Attribution model: the popup CTA click plants the SAME sr_login_ctx
-- cookie the navbar CTA uses (shared writeLoginCtxCookie helper), so a
-- later login_completed row carries the same anon session id. A signin
-- counts as popup-attributed when its session recorded a popup CTA click
-- strictly BEFORE the completion (temporal join at read time).
--
-- Privacy notes (same deliberate contract as 015):
-- - session_id is a random browser UUID (localStorage), NOT a Steam ID —
--   the funnel stays anonymous; no user table, no join to accounts.
-- - search_id is nullable (no popup/search correlation when the popup
--   shows outside a search) and carries NO foreign key: the beacon is
--   best-effort and must never fail on an unknown/missing search row.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts), so
-- the statements below never replay. Apply with `pnpm run db:migrate`.
-- =====================================================================

CREATE TABLE IF NOT EXISTS login_popup_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL CHECK(event IN ('login_popup_shown', 'login_popup_cta_clicked')),
  session_id  TEXT,                                 -- anon browser UUID; NULL when storage/cookie unavailable
  search_id   TEXT,                                 -- active search at event time; NULL outside a search
  created_at  TEXT NOT NULL                         -- ISO-8601 timestamp
);
CREATE INDEX IF NOT EXISTS idx_login_popup_event ON login_popup_events(event, session_id);
CREATE INDEX IF NOT EXISTS idx_login_popup_session ON login_popup_events(session_id);
