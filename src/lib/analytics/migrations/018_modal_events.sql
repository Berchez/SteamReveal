-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 018_modal_events
--
-- Per-modal engagement instrumentation (SponsorMe / SupportMe /
-- login-prompt), so each promo modal answers four questions instead of
-- anecdotes: how many times it was shown, how many times its CTA was
-- clicked, how many times it was closed via X, and how many times users
-- asked to never see it again.
--
-- Separate table (NOT new events in login_funnel_events or
-- login_popup_events): both tables carry CHECK(event IN (...)) guards
-- that SQLite cannot ALTER in place — new events there would require a
-- rebuild with data copy and risk the existing funnel data. A fresh table
-- carries zero migration risk (same rationale as 016).
--
-- Raw counts only (no sessions, no rates): the questions are "how many
-- times", repeats included — a user who sees the modal five times counts
-- five impressions. No conversion rate is derived.
--
-- Deliberately NO session_id / search_id (unlike 015/016): nothing reads
-- them back — the dashboard renders raw counts — so they would be
-- write-only identifiers expanding the privacy footprint (a persistent
-- browser UUID for every modal viewer, joinable to searched profiles)
-- for zero product use. If per-session analysis is ever needed, it wants
-- its own migration with its own privacy review, not silent columns here.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts), so
-- the statements below never replay. Apply with `pnpm run db:migrate`.
-- =====================================================================

-- modal has NO CHECK by design: a 4th modal (ban-reveal prompt, cookie
-- banner, …) must land with zero migration risk — the app allowlist
-- (MODAL_KINDS + parser) is the enforcement point, and getModalStats maps
-- only known modals, so an unknown modal row in the DB is silently
-- ignored, never panel corruption. The event set is stable (a modal
-- lifecycle has exactly these four transitions), so its CHECK stays as
-- the last line of defense for data quality.
CREATE TABLE IF NOT EXISTS modal_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  modal       TEXT NOT NULL,
  event       TEXT NOT NULL CHECK(event IN ('shown', 'cta_clicked', 'closed', 'dismissed')),
  created_at  TEXT NOT NULL                         -- ISO-8601 timestamp
);
-- Composite covering index for the panel's GROUP BY (modal, event).
CREATE INDEX IF NOT EXISTS idx_modal_event ON modal_events(modal, event);
