-- =====================================================================
-- Turso (SQLite) schema — analytics
-- Migration: 017_login_funnel_mid_steps
--
-- Steam-login funnel, mid-step instrumentation: the 015 funnel only sees
-- the two ends (navbar click -> completed login), so a click that never
-- converts is indistinguishable between "abandoned at Steam's OpenID
-- page" and "logged into Steam but never added the bot" (waiting room
-- expired). Two server-side-only steps close that gap:
-- - login_callback_hit: the callback proved the Steam identity (state +
--   assertion verified) — the user came back authenticated, whatever the
--   friendship gate says next. Forged/random hits that fail the gates
--   never reach the writer, so this row MEANS a real return.
-- - login_waiting_entered: the friendship gate held a verified non-friend
--   (login-first waiting room). waiting_entered MINUS per-session
--   completions is the "logged in but never added the bot" leak.
--
-- SQLite cannot widen a CHECK in place, so the table is rebuilt (new
-- table -> copy -> drop -> rename) with every existing row preserved.
-- Runs inside migrate-db's per-file batch transaction: all-or-nothing.
-- No FKs reference this table (analytics writes are FK-free by design),
-- and the two indexes are recreated after the rename (DROP TABLE drops
-- the originals with it).
--
-- Privacy: same contract as 015 — session_id stays a random browser UUID
-- (never a Steam ID), search_id nullable with no FK.
--
-- Applied once via the _migrations ledger (see scripts/migrate-db.ts).
-- Apply with `pnpm run db:migrate`.
-- =====================================================================

-- Re-runnable prologue: if a previous apply died after the CREATE but
-- before the RENAME (non-transactional runner, manual sqlite3 apply), the
-- leftover table would collide below. migrate-db runs the file in one
-- batch transaction, so this is a no-op there — pure belt-and-braces.
DROP TABLE IF EXISTS login_funnel_events_new;

CREATE TABLE login_funnel_events_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event       TEXT NOT NULL CHECK(event IN ('login_cta_clicked', 'login_callback_hit', 'login_waiting_entered', 'login_completed')),
  session_id  TEXT,                                 -- anon browser UUID; NULL when the CTA cookie was absent/unreadable
  search_id   TEXT,                                 -- active search at click time; NULL outside a search
  created_at  TEXT NOT NULL                         -- ISO-8601 timestamp
);

INSERT INTO login_funnel_events_new (id, event, session_id, search_id, created_at)
  SELECT id, event, session_id, search_id, created_at FROM login_funnel_events;

DROP TABLE login_funnel_events;

ALTER TABLE login_funnel_events_new RENAME TO login_funnel_events;

-- Same pair as 015 (event has 4 values now — still near-zero selectivity
-- alone; the pair keeps the panel's intersection subqueries index-assisted).
CREATE INDEX IF NOT EXISTS idx_login_funnel_event ON login_funnel_events(event, session_id);
CREATE INDEX IF NOT EXISTS idx_login_funnel_session ON login_funnel_events(session_id);
