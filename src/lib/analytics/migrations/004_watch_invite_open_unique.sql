-- Watch Bot open-invite uniqueness (follow-up to 002_watch_bot.sql).
--
-- At most one OPEN invite event (status queued/claimed) per profile. The
-- enqueueEvent pre-check in src/lib/analytics/db.ts collapses sequential
-- duplicates, but a genuinely concurrent double-submit could slip two rows
-- past that read. This partial index closes that window: the loser of the
-- race gets a UNIQUE violation and re-reads the winner's row (same
-- catch-and-re-read pattern as the notify UNIQUE(search_id) path).
--
-- Partial (not full) by design: settled history (sent/dropped) must NOT
-- block a fresh invite after expiry — only open rows participate.
-- SQLite partial indexes need 3.8+; Turso/libSQL supports them.
--
-- Fresh-feature assumption: if a pre-existing database somehow holds two
-- open invites for one profile, this statement fails loudly at migrate
-- time (fix by settling all but the oldest before re-running) instead of
-- silently enforcing on a subset.

CREATE UNIQUE INDEX IF NOT EXISTS idx_watch_events_open_invite
  ON watch_events (steam_id)
  WHERE kind = 'invite' AND status IN ('queued', 'claimed');
