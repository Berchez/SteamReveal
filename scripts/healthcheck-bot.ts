#!/usr/bin/env node
/**
 * Watch Bot healthcheck — `pnpm run healthcheck:bot`.
 *
 * Reads the heartbeat file the bot process writes (see
 * src/bot-steam/heartbeat.ts) and exits 0 when healthy, 1 otherwise.
 * Thin wiring on purpose: all evaluation logic lives in heartbeat.ts and
 * is unit-tested there; this script only resolves env, reads the file,
 * and maps the verdict to an exit code.
 *
 * Env (all optional, sane defaults):
 *   BOT_DATA_DIR            base dir (default .data/steam-bot)
 *   BOT_HEARTBEAT_PATH      heartbeat file (default <BOT_DATA_DIR>/heartbeat.json)
 *   BOT_HEARTBEAT_STALE_MS  staleness threshold (default 180000)
 */
import fs from 'fs';

import { loadEnv } from '../src/lib/env';
import { evaluateHeartbeat } from '../src/bot-steam/heartbeat';

// Mirror the bot defaults without importing its config module (which would
// require bot credentials env vars just to check health — the healthcheck
// must work from monitoring contexts that don't have them).
const resolveHeartbeatPath = (): string => {
  if (process.env.BOT_HEARTBEAT_PATH) return process.env.BOT_HEARTBEAT_PATH;
  const dataDir = process.env.BOT_DATA_DIR || '.data/steam-bot';
  return `${dataDir}/heartbeat.json`;
};

const resolveStaleMs = (): number => {
  const raw = process.env.BOT_HEARTBEAT_STALE_MS;
  if (raw === undefined || raw === '') return 180000;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    // eslint-disable-next-line no-console
    console.error(
      `BOT_HEARTBEAT_STALE_MS must be a positive number of milliseconds (got ${JSON.stringify(raw)})`,
    );
    process.exit(2);
  }
  return Math.floor(parsed);
};

async function main(): Promise<void> {
  loadEnv();

  const filePath = resolveHeartbeatPath();
  const staleMs = resolveStaleMs();

  let raw: string | null = null;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    raw = null;
  }

  const verdict = evaluateHeartbeat(raw, staleMs);
  if (verdict.healthy) {
    // eslint-disable-next-line no-console
    console.log(
      `BOT HEALTHCHECK PASS (heartbeat age ${Math.round(verdict.ageMs / 1000)}s, file ${filePath})`,
    );
    return;
  }

  // eslint-disable-next-line no-console
  console.error(`BOT HEALTHCHECK FAIL: ${verdict.reason} (file ${filePath})`);
  process.exit(1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('BOT HEALTHCHECK ERROR:', err);
  process.exit(1);
});
