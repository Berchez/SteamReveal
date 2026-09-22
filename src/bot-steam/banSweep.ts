/**
 * Ban Reveal sweep poller (Phase 1) — produces work, does not drain a queue.
 *
 * Runs on its own multi-hour interval. Reads DISTINCT target_steam_id where
 * source = 'steam' (NOT once per subscription row — a popular target with
 * many subscribers still costs exactly one slot in the batch), batches them
 * for GetPlayerBans (up to 100 IDs per call — batch, never call
 * per-profile), and diffs against last_known_banned:
 *
 * - false -> true: mark the target banned + fan out one ban_alert outbox
 *   event per un-notified subscription (atomic per subscription via
 *   enqueueBanAlertForSubscription, which gates on notified_at IS NULL in
 *   the same batch). This 1-to-many fan-out is the whole reason the
 *   subscriber/target split exists.
 * - true -> false (unban / data correction): flip the flag only. Never
 *   clears notified_at — no re-alerting on a flapping ban status without
 *   an explicit product decision.
 * - First-ever sighting of an already-banned target: set the baseline with
 *   NO fan-out (a pre-existing ban is not a new detection — this is the
 *   safety net under the subscribe-time already-banned gate's fail-open
 *   path, so a live-check failure there can never manufacture an alert).
 *
 * Freshness is explicitly not a requirement: a stale-by-hours verdict is
 * fine, so every default biases toward lower quota usage, not speed.
 * Every failure mode (Steam down, malformed row, one bad steamId in a
 * batch) logs loudly, never crashes the pass, and never blocks the rest
 * of the batch. The Steam caller is injected (unit tests never touch the
 * network); the production caller wraps steamapi.getUserBans.
 */

import type { WatchBotLogger } from './logger';

export interface BanSweepTargetState {
  targetSteamId: string;
  lastKnownBanned: boolean;
  lastBanCheckedAt: string | null;
}

export interface BanSweepDal {
  listDistinctBanTargets: (limit: number) => Promise<string[]>;
  getBanTarget: (targetSteamId: string) => Promise<BanSweepTargetState | null>;
  markBanTargetChecked: (
    targetSteamId: string,
    banned: boolean,
  ) => Promise<void>;
  listUnnotifiedBanSubscriptions: (targetSteamId: string) => Promise<
    Array<{
      id: number;
      subscriberSteamId: string;
    }>
  >;
  enqueueBanAlertForSubscription: (
    subscriptionId: number,
    subscriberSteamId: string,
  ) => Promise<{ enqueued: boolean; eventId: number | null }>;
}

/** One batched ban verdict per target (true = VAC or game ban). */
export type BanVerdictByTarget = Map<string, boolean>;

/** Injected Steam surface: batch verdicts, never per-profile calls. */
export type BanSteamCaller = (
  targetSteamIds: string[],
) => Promise<BanVerdictByTarget>;

export interface BanSweepReport {
  /** Distinct targets examined this pass. */
  checked: number;
  /** Targets that transitioned false -> true (new detections). */
  transitions: number;
  /** Subscription alerts fanned out. */
  alerted: number;
  errors: Array<{ targetSteamId: string; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip). */
  skipped: boolean;
}

export interface PollBanSweepOptions {
  dal: BanSweepDal;
  /** Batched Steam ban verdicts (max 100 ids per call — chunked here). */
  steamCaller: BanSteamCaller;
  logger?: WatchBotLogger;
  /** Distinct targets per pass (default 100 = one GetPlayerBans call). */
  batchLimit?: number;
}

const DEFAULT_BATCH_LIMIT = 100;
/** GetPlayerBans takes at most 100 IDs per call — chunk, never per-profile. */
const STEAM_IDS_PER_CALL = 100;

const chunk = <T>(items: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
};

interface ProcessTargetResult {
  checked: number;
  transitioned: number;
  alerted: number;
  errors: Array<{ targetSteamId: string; message: string }>;
}

const processTarget = async (
  dal: BanSweepDal,
  logger: WatchBotLogger,
  targetSteamId: string,
  verdicts: BanVerdictByTarget,
): Promise<ProcessTargetResult> => {
  const result: ProcessTargetResult = {
    checked: 0,
    transitioned: 0,
    alerted: 0,
    errors: [],
  };
  const verdict = verdicts.get(targetSteamId);
  // No verdict (chunk failed, target absent from the response): degrade to
  // "unchecked this pass" — never mark, never alert, never block others.
  if (verdict === undefined) return result;

  const previous = await dal.getBanTarget(targetSteamId);
  const wasBanned = previous?.lastKnownBanned ?? false;
  const everChecked =
    previous?.lastBanCheckedAt !== null &&
    previous?.lastBanCheckedAt !== undefined;

  result.checked = 1;

  if (!wasBanned && verdict) {
    if (!everChecked) {
      // First-ever sighting of an already-banned target: pre-existing ban,
      // not a new detection. Set the baseline, alert NOBODY (the sweep-side
      // twin of the subscribe-time already-banned gate).
      await dal.markBanTargetChecked(targetSteamId, true);
      // Ambiguity observability (the one silent-miss hole in this design):
      // checked_at NULL here means NO subscribe-time verification ever
      // succeeded for this target (live check failed or errored every
      // time). If the ban actually landed AFTER subscribing but BEFORE
      // this first sighting, it is indistinguishable from a pre-existing
      // ban — and the subscribers below will never be alerted. That must
      // never be silent: count the affected (still ungated) subscriptions
      // and log LOUD so ops can tell "legit baseline" apart from "missed
      // new ban". (Fixing it properly needs a ban timestamp — e.g. Steam's
      // DaysSinceLastBan — which is a product decision, not this pass.)
      let pending = 0;
      try {
        const subs = await dal.listUnnotifiedBanSubscriptions(targetSteamId);
        pending = subs.length;
      } catch (error) {
        logger.error(
          `[WatchBot] ban sweep baseline count failed: target=${targetSteamId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (pending > 0) {
        logger.error(
          `[WatchBot] ban sweep AMBIGUOUS baseline (possible missed alert): target=${targetSteamId} ` +
            `was never verified before subscribing and is banned at first sighting — ` +
            `${pending} subscriber(s) will NOT be alerted. ` +
            `Grep subscribe-time '[BanWatch]' errors for this target to confirm a failed live check.`,
        );
      } else {
        logger.info(
          `[WatchBot] ban sweep baseline (pre-existing ban, no alert): target=${targetSteamId}`,
        );
      }
      return result;
    }
    await dal.markBanTargetChecked(targetSteamId, true);
    result.transitioned = 1;
    const subs = await dal.listUnnotifiedBanSubscriptions(targetSteamId);
    // Sequential per-subscription awaits are intentional (same rationale
    // as the chat lanes: determinism over throughput at this volume).
    // eslint-disable-next-line no-restricted-syntax
    for (const sub of subs) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const { enqueued } = await dal.enqueueBanAlertForSubscription(
          sub.id,
          sub.subscriberSteamId,
        );
        if (enqueued) result.alerted += 1;
      } catch (error) {
        logger.error(
          `[WatchBot] ban alert fan-out failed: target=${targetSteamId} subscriptionId=${sub.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        result.errors.push({
          targetSteamId,
          message: `subscriptionId=${sub.id}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        });
      }
    }
    logger.info(
      `[WatchBot] ban detected: target=${targetSteamId} alerted=${subs.length}`,
    );
    return result;
  }

  if (wasBanned && !verdict) {
    // Unban / data correction: flip the flag only. notified_at stays set
    // (no re-alert on flap without an explicit product decision).
    await dal.markBanTargetChecked(targetSteamId, false);
    logger.info(
      `[WatchBot] ban cleared (no re-alert): target=${targetSteamId}`,
    );
    return result;
  }

  // No transition (still clean, or still banned): refresh the sighting
  // timestamp so the oldest-first ordering keeps converging.
  await dal.markBanTargetChecked(targetSteamId, verdict);
  return result;
};

export const pollBanSweepOnce = async (
  options: PollBanSweepOptions,
): Promise<BanSweepReport> => {
  const {
    dal,
    steamCaller,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
  } = options;

  const startedAt = Date.now();
  const report: BanSweepReport = {
    checked: 0,
    transitions: 0,
    alerted: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  let targets: string[];
  try {
    targets = await dal.listDistinctBanTargets(batchLimit);
  } catch (error) {
    // A dead DAL must not crash the interval driver: loud error, empty pass.
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[WatchBot] ban sweep listing failed: ${message}`);
    report.errors.push({ targetSteamId: '', message });
    report.durationMs = Date.now() - startedAt;
    return report;
  }
  if (targets.length === 0) return report;

  // Batch the Steam calls (100 ids each), isolating per-chunk failures so
  // one bad steamId never blocks the rest of the batch.
  const verdicts: BanVerdictByTarget = new Map();
  // eslint-disable-next-line no-restricted-syntax
  for (const ids of chunk(targets, STEAM_IDS_PER_CALL)) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const chunkVerdicts = await steamCaller(ids);
      chunkVerdicts.forEach((banned, id) => {
        verdicts.set(id, banned);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[WatchBot] ban sweep Steam check failed for ${ids.length} target(s): ${message}`,
      );
      // eslint-disable-next-line no-restricted-syntax
      for (const id of ids) {
        report.errors.push({ targetSteamId: id, message });
      }
    }
  }

  // Diff + fan out, one target at a time (per-row isolation: a sick row
  // logs loudly and the pass moves on).
  // eslint-disable-next-line no-restricted-syntax
  for (const targetSteamId of targets) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const partial = await processTarget(dal, logger, targetSteamId, verdicts);
      report.checked += partial.checked;
      report.transitions += partial.transitioned;
      report.alerted += partial.alerted;
      report.errors.push(...partial.errors);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `[WatchBot] ban sweep target failed: target=${targetSteamId}: ${message}`,
      );
      report.errors.push({ targetSteamId, message });
    }
  }

  report.durationMs = Date.now() - startedAt;
  if (report.checked > 0 || report.transitions > 0) {
    logger.info(
      `[WatchBot] ban sweep done: checked=${report.checked} transitions=${report.transitions} ` +
        `alerted=${report.alerted} errors=${report.errors.length} durationMs=${report.durationMs}`,
    );
  }
  return report;
};

export interface BanSweeperHandle {
  stop: () => void;
  pollOnce: () => Promise<BanSweepReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring every other lane) so startup ordering stays visible
 * at the call site. Timer is unref'd: the Steam connection owns process
 * lifetime, not the sweeper.
 */
export const startBanSweeper = (
  options: PollBanSweepOptions & { sweepIntervalMs: number },
): BanSweeperHandle => {
  const { sweepIntervalMs, logger = console } = options;
  if (!Number.isFinite(sweepIntervalMs) || sweepIntervalMs <= 0) {
    throw new Error(
      'Invalid ban sweep interval: expected positive milliseconds',
    );
  }

  // Overlap guard, same pattern as every poll*Once driver: a pass slower
  // than the interval must not stack a second concurrent pass — concurrent
  // sweeps would double-spend Steam quota and race the fan-out gate.
  let running = false;
  const pollOnce = async (): Promise<BanSweepReport> => {
    if (running) {
      logger.info(
        '[WatchBot] ban sweep skipped (previous pass still running)',
      );
      return {
        checked: 0,
        transitions: 0,
        alerted: 0,
        errors: [],
        durationMs: 0,
        skipped: true,
      };
    }
    running = true;
    try {
      return await pollBanSweepOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] ban sweep pass failed: ${
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
    pollOnce,
  };
};
