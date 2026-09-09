/**
 * Stale-claim sweeper — the driver for resetStaleClaims (DAL).
 *
 * Rows stuck in 'claimed' (worker crashed between claim and settle, or
 * bookkeeping failed after a successful send) would otherwise sit forever:
 * no poller re-reads claimed rows. This interval requeues the ones older
 * than the window so the next poll retries them.
 *
 * Deliberately separate from the invite poller: the sweep is lane-agnostic
 * (covers future notify events too) and runs on its own slow cadence. No
 * overlap guard here, unlike the poller — the sweep is a single idempotent
 * UPDATE, so a concurrent run is harmless by construction.
 */

export interface StaleSweepDal {
  resetStaleClaims: (olderThanMinutes: number) => Promise<number>;
}

export interface StaleSweepLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface StaleSweepOptions {
  dal: StaleSweepDal;
  logger?: StaleSweepLogger;
  staleWindowMinutes: number;
}

export interface StartStaleSweepOptions extends StaleSweepOptions {
  sweepIntervalMs: number;
}

/**
 * One sweep: requeues orphaned claims older than the window. Returns how
 * many rows were requeued. Logs only when something actually moved (quiet
 * is the common case); throws on DAL failure for the caller to handle.
 */
export const sweepStaleClaimsOnce = async (
  options: StaleSweepOptions,
): Promise<number> => {
  const { dal, logger = console, staleWindowMinutes } = options;

  const requeued = await dal.resetStaleClaims(staleWindowMinutes);
  if (requeued > 0) {
    logger.info(
      `[WatchBot] stale sweep requeued ${requeued} orphaned claim(s) older than ${staleWindowMinutes}min`,
    );
  }
  return requeued;
};

export interface StaleSweepHandle {
  stop: () => void;
}

export const startStaleClaimSweeper = (
  options: StartStaleSweepOptions,
): StaleSweepHandle => {
  const { sweepIntervalMs, logger = console } = options;
  if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new Error(
      'Invalid stale sweep interval: expected positive milliseconds',
    );
  }

  const timer = setInterval(() => {
    sweepStaleClaimsOnce(options).catch((error: unknown) => {
      logger.error(
        `[WatchBot] stale sweep failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, sweepIntervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
  };
};
