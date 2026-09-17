-- =====================================================================
-- Turso (SQLite) schema — bot heartbeat mirror for the site's liveness gate.
-- Migration: 011_bot_heartbeat.sql
--
-- Replay-safe at the SQL level (CREATE TABLE IF NOT EXISTS); the
-- _migrations row is the runner's bookkeeping on top of that (010's
-- contract). NEVER RENAME this file after it has been applied anywhere.
-- Apply with `pnpm run db:migrate`.
--
-- Design notes:
-- - The bot writes a LOCAL heartbeat file (BOT_HEARTBEAT_PATH) for
--   `pnpm run healthcheck:bot`, but the Vercel site cannot read that file
--   across hosts. This table is the shared bridge: the bot upserts one
--   row every BOT_HEARTBEAT_INTERVAL_MS, and the SiteNav liveness gate
--   (src/lib/watch/botLiveness.ts) hides the sign-in button when the bot
--   cannot promise a login — TWO offline causes, both demonstrable:
--   a STALE beat (process down, ~4 min) or a SUSTAINED disconnected
--   session (connected=0 held >= ~5 min per disconnected_since — the
--   runbook §7 class: banned/flagged account, pending Steam Guard,
--   long Steam outage with the process still alive and beating).
--   Fail-open everywhere: no row, a DB blip, or a corrupt timestamp
--   never hides the button.
-- - Single row, fixed id=1 (CHECK enforces it): an upsert, never an
--   append, so the table never grows.
-- - `connected` + `steam_id` are stored for ops visibility (db:smoke,
--   manual checks); the gate reads beat age + connected/disconnected_since.
-- - `disconnected_since` is maintained ATOMICALLY by the upsert SQL in
--   db.ts (recordBotHeartbeat): a connected beat clears it; a
--   disconnected beat keeps the EARLIEST existing value (COALESCE), so
--   overlapping writes can never restart the window and the gate always
--   measures the true sustained-outage duration. NULL = connected at the
--   last beat (or written by an older bot version that predates the
--   column — the gate treats that as unknown and fails open, exactly
--   like a missing row).
-- - DEPLOY ORDER: run `pnpm run db:migrate` and deploy the bot (starts
--   writing) BEFORE the site change that reads this table. Until a beat
--   exists the site treats liveness as unknown → fail-open (button shows),
--   so a reversed order degrades safely, never blocks logins.
--
-- ROLLBACK (documentation only — never as a separate migration file: the
-- runner would apply it forward and DROP the table):
--   DROP TABLE IF EXISTS bot_heartbeat;
--   DELETE FROM _migrations WHERE filename = '011_bot_heartbeat.sql';
-- Losing this table only degrades the site's sign-in gate to fail-open
-- (the button always shows) — no user data lives here.
-- =====================================================================

CREATE TABLE IF NOT EXISTS bot_heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  beat_at TEXT NOT NULL,
  connected INTEGER NOT NULL,
  steam_id TEXT,
  -- ISO-8601 of when the Steam session FIRST went disconnected in the
  -- current streak (NULL while connected). See the design notes above.
  disconnected_since TEXT
);
