/**
 * Watch Bot history-retention purge — cuts the who-searched-whom link
 * (search_meta.searcher_steam_id → NULL) on searches older than the TTL.
 * The searches themselves stay (dashboard aggregates and target inboxes
 * never show searcher identity, so they are unaffected); only the
 * investigator↔investigated attribution expires.
 *
 * DB-only lane (no Steam surface at all): deliberately NOT gated on
 * isConnected — retention must advance during Steam outages too. Single
 * UPDATE per pass (no batching needed: one statement clears every
 * expired row), overlap-guarded interval driver with the same
 * start/stop/pollOnce shape as the other lanes.
 *
 * This module never sees credentials (no secrets in scope by construction).
 */

import type { WatchBotLogger } from './logger';
import { logBotPassError, markBotPassHealthy } from './transientError';
import { SEARCHER_LINK_TTL_MS } from '../lib/analytics/historyLimits';

export interface HistoryPurgeDal {
  purgeExpiredSearcherLinks: (olderThanIso: string) => Promise<number>;
}

export interface HistoryPurgeReport {
  /** Rows de-attributed this pass (0 = nothing expired). */
  purged: number;
  /** Cutoff the pass applied (ISO wall-clock). */
  cutoffIso: string;
  durationMs: number;
  /** True when the pass did no work (overlap skip). */
  skippedPass: boolean;
}

export interface PollHistoryPurgeOptions {
  dal: HistoryPurgeDal;
  logger?: WatchBotLogger;
  /** Clock seam (tests): "now" the TTL is measured from. */
  nowMs?: number;
}

export const purgeHistoryOnce = async (
  options: PollHistoryPurgeOptions,
): Promise<HistoryPurgeReport> => {
  const { dal, logger = console, nowMs = Date.now() } = options;
  const startedAt = Date.now();
  const cutoffIso = new Date(nowMs - SEARCHER_LINK_TTL_MS).toISOString();

  const purged = await dal.purgeExpiredSearcherLinks(cutoffIso);

  logger.info(
    `[WatchBot] history purge: de-attributed=${purged} older than ${cutoffIso}`,
  );
  return {
    purged,
    cutoffIso,
    durationMs: Date.now() - startedAt,
    skippedPass: false,
  };
};

export interface HistoryPurgePollerHandle {
  stop: () => void;
  pollOnce: () => Promise<HistoryPurgeReport>;
}

/**
 * Node clamps setInterval delays past 2^31-1 (~24.8d) to ~1ms with a
 * TimeoutOverflowWarning — a "monthly" override (2.6e9) would hot-loop
 * the purge daily job every millisecond. Cap defensively: precision
 * needs days here, so the cap never binds a sane config.
 */
export const MAX_HISTORY_PURGE_INTERVAL_MS = 2 ** 31 - 1;

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly) so startup ordering stays visible at the call site. Timer is
 * unref'd like every other lane: the Steam connection owns process
 * lifetime, not the poller.
 */
export const startHistoryPurgePoller = (
  options: PollHistoryPurgeOptions & { pollIntervalMs: number },
): HistoryPurgePollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid history purge interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through pollOnce). A purge is
  // a single UPDATE, so overlap is unlikely — the guard is uniformity
  // with the other lanes, not a hot path.
  let running = false;
  const pollOnce = async (): Promise<HistoryPurgeReport> => {
    if (running) {
      logger.info(
        '[WatchBot] history purge skipped (previous pass still running)',
      );
      return {
        purged: 0,
        cutoffIso: '',
        durationMs: 0,
        skippedPass: true,
      };
    }
    running = true;
    try {
      return await purgeHistoryOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().then(
      () => {
        markBotPassHealthy('history purge pass failed');
      },
      (error: unknown) => {
        logBotPassError(logger, 'history purge pass failed', error);
      },
    );
  }, Math.min(pollIntervalMs, MAX_HISTORY_PURGE_INTERVAL_MS));
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
    pollOnce,
  };
};
