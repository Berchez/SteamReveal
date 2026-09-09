/**
 * Watch Bot heartbeat (WB-5).
 *
 * The bot process writes a small JSON file on an interval; the standalone
 * healthcheck (scripts/healthcheck-bot.ts) reads it. File, not HTTP: the
 * bot has no server socket, and a file works identically on any host.
 *
 * The payload NEVER contains secrets — only process liveness facts. Tests
 * assert the exact key set so a future field can't leak one silently.
 */
import fs from 'fs';
import path from 'path';

export interface HeartbeatStatus {
  /** Whether the Steam client currently reports a live session. */
  connected: boolean;
  /** Bot's own SteamID64 once logged on, null before first logon. */
  steamId: string | null;
}

export interface HeartbeatPayload {
  /** ISO-8601 of this write. */
  timestamp: string;
  pid: number;
  /** Seconds since this process started (monotonic-ish, Date-based). */
  uptimeSec: number;
  connected: boolean;
  steamId: string | null;
}

export interface HeartbeatHandle {
  /** Writes one beat immediately (used at startup so health is instant). */
  beat: () => void;
  stop: () => void;
}

const HEARTBEAT_PAYLOAD_KEYS = [
  'timestamp',
  'pid',
  'uptimeSec',
  'connected',
  'steamId',
] as const;

const ensureParentDir = (filePath: string): void => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
};

/**
 * Starts the periodic heartbeat writer. Synchronous file writes: the
 * payload is a few hundred bytes, and sync keeps shutdown semantics trivial
 * (stop() guarantees nothing is still in flight).
 */
export const startHeartbeat = (options: {
  filePath: string;
  intervalMs: number;
  getStatus: () => HeartbeatStatus;
  startedAt?: number;
  now?: () => number;
  pid?: number;
}): HeartbeatHandle => {
  const startedAt = options.startedAt ?? Date.now();
  const now = options.now ?? Date.now;
  const pid = options.pid ?? process.pid;

  const beat = (): void => {
    const status = options.getStatus();
    const payload: HeartbeatPayload = {
      timestamp: new Date(now()).toISOString(),
      pid,
      uptimeSec: Math.max(0, Math.floor((now() - startedAt) / 1000)),
      connected: status.connected,
      steamId: status.steamId,
    };
    ensureParentDir(options.filePath);
    fs.writeFileSync(
      options.filePath,
      `${JSON.stringify(payload, null, 2)}\n`,
    );
  };

  const timer = setInterval(() => {
    try {
      beat();
    } catch {
      // A heartbeat must never crash the bot: a full disk or a removed
      // directory degrades to "stale heartbeat", which is exactly what the
      // healthcheck reports. The next tick retries.
    }
  }, options.intervalMs);
  if (typeof timer.unref === 'function') {
    // Never hold the event loop open for heartbeats alone: during graceful
    // shutdown, stop() + pending work decide the lifetime, not this timer.
    timer.unref();
  }

  return {
    beat,
    stop: () => clearInterval(timer),
  };
};

export type HeartbeatHealth =
  | { healthy: true; ageMs: number }
  | { healthy: false; reason: string };

/**
 * Pure health evaluation shared by the healthcheck script (unit-tested
 * here, thin wiring there). `raw` is the file content (null = missing).
 */
export const evaluateHeartbeat = (
  raw: string | null,
  staleAfterMs: number,
  now: number = Date.now(),
): HeartbeatHealth => {
  if (raw === null) {
    return { healthy: false, reason: 'heartbeat file is missing' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { healthy: false, reason: 'heartbeat file is not valid JSON' };
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { timestamp?: unknown }).timestamp !== 'string'
  ) {
    return { healthy: false, reason: 'heartbeat file has no timestamp' };
  }
  const writtenAt = Date.parse(
    (parsed as { timestamp: string }).timestamp,
  );
  if (!Number.isFinite(writtenAt)) {
    return { healthy: false, reason: 'heartbeat timestamp is not parseable' };
  }
  const ageMs = now - writtenAt;
  if (ageMs < 0) {
    return { healthy: false, reason: 'heartbeat timestamp is in the future' };
  }
  if (ageMs > staleAfterMs) {
    return {
      healthy: false,
      reason: `heartbeat is stale (age ${Math.round(ageMs / 1000)}s > ${Math.round(staleAfterMs / 1000)}s)`,
    };
  }
  return { healthy: true, ageMs };
};

export { HEARTBEAT_PAYLOAD_KEYS };
