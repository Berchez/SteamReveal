import { isTransientInfraError } from '../lib/transientInfra';
import type { WatchBotLogger } from './logger';

// Steam-session flap markers, owned by the capped-backoff reconnect loop
// (bot.ts): a dropped session makes every lane miss its pass, so logging
// those misses as errors would double-count one incident.
const STEAM_FLAP_PATTERN = /(?:NoConnection|ServiceUnavailable)/i;

// Sustained-outage escalation: a lone blip is warn, but N CONSECUTIVE
// transient misses of the SAME lane mean the lane is stuck (not
// self-healing) and earn an error so errors.log keeps a signal. Windowed
// counting was tried first and got this wrong in both directions: slow
// lanes (ban sweep every 6h) can never fit 5 misses in 10 minutes, so
// they stayed warn forever; flapping lanes (fail/ok/fail) escalated
// without being sick. Consecutive counting with reset-on-success fixes
// both: any resolved pass clears the streak, so only an unbroken failure
// run escalates, at exactly the lane's own pace.
export const TRANSIENT_ESCALATION_THRESHOLD = 5;

const consecutiveTransientFailures = new Map<string, number>();

/** Test-only seam: per-label failure streaks are module state. */
export const resetBotPassErrorCountsForTests = (): void => {
  consecutiveTransientFailures.clear();
};

const recordTransientFailure = (label: string): number => {
  const streak = (consecutiveTransientFailures.get(label) ?? 0) + 1;
  consecutiveTransientFailures.set(label, streak);
  return streak;
};

/**
 * Clears a lane's transient-failure streak — call when its pass resolves
 * (every driver pairs `.then(ok, error)` on the same label). A resolved
 * pass is evidence of health even if it carried per-item errors (those
 * log ERROR individually at the row level); only an unbroken run of
 * thrown passes may escalate. Silent by design: success is the norm and
 * must not spam the log.
 */
export const markBotPassHealthy = (label: string): void => {
  consecutiveTransientFailures.delete(label);
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
      `${line} (${recentCount} consecutive transient failures — escalated)`,
    );
    return;
  }
  if (typeof logger.warn === 'function') {
    logger.warn(line);
  } else {
    logger.info(line);
  }
};
