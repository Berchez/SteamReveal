import { isTransientInfraError } from '../lib/transientInfra';
import type { WatchBotLogger } from './logger';

// Steam-session flap markers, owned by the capped-backoff reconnect loop
// (bot.ts): a dropped session makes every lane miss its pass, so logging
// those misses as errors would double-count one incident.
const STEAM_FLAP_PATTERN = /(?:NoConnection|ServiceUnavailable)/i;

// Sustained-outage escalation: a lone blip is warn, but N transient misses
// of the SAME lane inside the window mean the lane is stuck (not
// self-healing) and earn an error so errors.log keeps a signal. Windowed,
// not consecutive-counted: logBotPassError only ever sees failures, so a
// recovering lane naturally stops re-entering the window.
export const TRANSIENT_ESCALATION_WINDOW_MS = 10 * 60 * 1000;
export const TRANSIENT_ESCALATION_THRESHOLD = 5;

const recentTransientFailures = new Map<string, number[]>();

/** Test-only seam: per-label failure histories are module state. */
export const resetBotPassErrorCountsForTests = (): void => {
  recentTransientFailures.clear();
};

const recordTransientFailure = (label: string): number => {
  const now = Date.now();
  const pruned = (recentTransientFailures.get(label) ?? []).filter(
    (timestamp) => now - timestamp < TRANSIENT_ESCALATION_WINDOW_MS,
  );
  pruned.push(now);
  recentTransientFailures.set(label, pruned);
  return pruned.length;
};

/**
 * True when a bot-pass failure is transient infrastructure (Turso/network
 * blip, Turso-side 5xx/S3, dropped Steam session) rather than a logic bug.
 * Pass-level misses self-heal on the next tick (claim/retry + 30min stale
 * requeue), so callers log them at warn — out of errors.log — instead of
 * error, UNLESS the lane keeps missing inside the escalation window (see
 * above). Per-row signals (dropped after N attempts, sent-but-not-recorded)
 * must stay ERROR and never consult this.
 */
export const isBotTransientError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  if (isTransientInfraError(error)) return true;
  return STEAM_FLAP_PATTERN.test(error.message);
};

const safeDetail = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return '[unprintable error]';
  }
};

/**
 * Single-shape pass-failure logging for every bot interval driver: same
 * `[WatchBot] <label>: <detail>` line as the inlined version it replaces,
 * routed to warn for transient infra, error otherwise (and error on
 * sustained-transient escalation). Falls back to info when the logger has
 * no warn (old test doubles) so the downgrade never crashes a caller.
 */
export const logBotPassError = (
  logger: WatchBotLogger,
  label: string,
  error: unknown,
): void => {
  const line = `[WatchBot] ${label}: ${safeDetail(error)}`;
  if (!isBotTransientError(error)) {
    logger.error(line);
    return;
  }
  const recentCount = recordTransientFailure(label);
  if (recentCount >= TRANSIENT_ESCALATION_THRESHOLD) {
    logger.error(
      `${line} (${recentCount} transient failures in the last 10m — escalated)`,
    );
    return;
  }
  if (typeof logger.warn === 'function') {
    logger.warn(line);
  } else {
    logger.info(line);
  }
};
