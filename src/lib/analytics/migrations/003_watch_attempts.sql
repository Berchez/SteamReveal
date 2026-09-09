-- =====================================================================
-- Turso (SQLite) schema — Watch Bot retry accounting (Epic 3, WB-7).
-- Migration: 003_watch_attempts
--
-- Unlike 001/002, this statement is NOT safely re-runnable on its own
-- (ALTER TABLE ADD COLUMN fails if the column already exists). That is
-- fine by design: scripts/migrate-db.ts records applied files in
-- _migrations and never re-runs them, so each file executes exactly once
-- per database. Do NOT re-apply this file by hand on a migrated DB.
-- =====================================================================

-- Attempt counter for poller retries (invite sender, Epic 3; notify sender
-- later). Lets a worker bound retries (drop after N) without losing count
-- across restarts — in-memory counting would reset on every crash and retry
-- a permanently-failing event forever.
ALTER TABLE watch_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
