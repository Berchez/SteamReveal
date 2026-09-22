/**
 * Ban Reveal subscribe hook (Phase 1) — called server-side from
 * POST /api/recordAnalyticsCheater right after attachCheaterProbability,
 * mirroring how POST /api/recordAnalytics calls enqueueWatchNotification
 * after recordSearch (same "hook at the write, not the client click"
 * pattern).
 *
 * Trigger scope is deliberately narrow: the explicit cheater-report open
 * ("Análise CS2 Anticheat - com IA" click), NOT every search. Broadening
 * to "any search by a logged-in user" was considered and rejected for
 * this phase (weaker signal per subscription, no unsubscribe UI).
 *
 * Never throws: every failure mode resolves to { subscribed: false } so
 * the cheater write always succeeds regardless of ban-watch health.
 */

import {
  createBanSubscription,
  ensureBanTarget,
  getBanTarget,
  getSteamIdBySearchId,
  markBanTargetChecked,
} from './db';

export interface BanSubscribeLogger {
  error: (message: string) => void;
}

export type BanSubscribeOutcome =
  | { subscribed: true; created: boolean }
  | { subscribed: false; reason: 'no-target' | 'error' };

export interface BanSubscribeDeps {
  getTargetSteamId?: (searchId: string) => Promise<string | null>;
  ensureTarget?: (targetSteamId: string) => Promise<void>;
  readTarget?: (
    targetSteamId: string,
  ) => Promise<{ lastKnownBanned: boolean; lastBanCheckedAt: string | null } | null>;
  checkBanned?: (targetSteamId: string) => Promise<boolean | null>;
  /**
   * Persists a live-check verdict (sweep-sighting equivalent). Injected
   * for tests; defaults to markBanTargetChecked. Fail-open (see below).
   */
  markChecked?: (targetSteamId: string, banned: boolean) => Promise<void>;
  create?: (
    subscriberSteamId: string,
    targetSteamId: string,
    searchId: string | null,
    alreadyBanned: boolean,
  ) => Promise<{ created: boolean }>;
}

// Single-flight for the live Steam check: concurrent subscribes for the
// same still-unswept target (the viral-profile case — one suspect shared
// on Discord, N opens at once) share ONE GetPlayerBans call instead of
// firing N against the shared key pool (quota is shared by default — the
// dedicated STEAM_BAN_CHECK_API_KEY is opt-in, so every saved call counts).
// Module-scoped, so per-instance on serverless (same accepted residual as
// the rate limiter); entries are deleted on settle, so nothing leaks and
// nothing goes stale — a later open re-checks live only if the sweep still
// hasn't sighted the target (the persist below normally prevents even
// that). The persist itself stays per-waiter (one idempotent single-row
// write each — not deduped, deliberately: sharing it would couple the
// waiters' error paths to save a write that costs nothing).
const liveCheckInFlight = new Map<string, Promise<boolean | null>>();

const singleFlightLiveCheck = (
  targetSteamId: string,
  run: () => Promise<boolean | null>,
): Promise<boolean | null> => {
  const running = liveCheckInFlight.get(targetSteamId);
  if (running) return running;
  const pending = run();
  liveCheckInFlight.set(targetSteamId, pending);
  // Delete-on-settle via dual-handler .then (NOT .finally: the derived
  // promise would reject unhandled when the check fails, while every
  // sharer already handles the original via the hook's try/catch).
  pending.then(
    () => {
      if (liveCheckInFlight.get(targetSteamId) === pending) {
        liveCheckInFlight.delete(targetSteamId);
      }
    },
    () => {
      if (liveCheckInFlight.get(targetSteamId) === pending) {
        liveCheckInFlight.delete(targetSteamId);
      }
    },
  );
  return pending;
};

export const subscribeBanWatcher = async (
  subscriberSteamId: string,
  searchId: string,
  logger: BanSubscribeLogger = console,
  deps: BanSubscribeDeps = {},
): Promise<BanSubscribeOutcome> => {
  const getTargetSteamId = deps.getTargetSteamId ?? getSteamIdBySearchId;
  const ensureTarget = deps.ensureTarget ?? ensureBanTarget;
  const readTarget = deps.readTarget ?? getBanTarget;
  const create = deps.create ?? createBanSubscription;
  try {
    // Target comes from the trusted profiles join, never from the client.
    // Self-subscription (subscriber === target: opening your OWN cheater
    // report) is deliberately NOT blocked — watching your own ban state is
    // a legitimate use, and nothing in Phase 1 assumes otherwise.
    const targetSteamId = await getTargetSteamId(searchId);
    if (targetSteamId === null) {
      return { subscribed: false, reason: 'no-target' };
    }
    await ensureTarget(targetSteamId);

    // Already-banned gate: a pre-existing ban is not a new detection and
    // must never fire an alert. Prefer the sweep's cached verdict when the
    // target was already sighted; otherwise do a single-ID live check and
    // PERSIST it as a sweep-equivalent sighting (fail-open to unknown —
    // the sweep's first-sighting baseline heals it without alerting, see
    // banSweep.ts). Persisting matters: without it every re-open of the
    // same still-unswept profile would fire another live Steam call, and
    // this subscriber's gate would disagree with the sweep's baseline.
    let alreadyBanned = false;
    try {
      const cached = await readTarget(targetSteamId);
      if (cached !== null && cached.lastBanCheckedAt !== null) {
        alreadyBanned = cached.lastKnownBanned;
      } else {
        // Single-flight (same pattern as getSteamIdentity /
        // watchStatusPrefetch): N concurrent opens of the same still-
        // unswept profile share ONE live Steam call instead of firing N.
        // The 4s budget matches the navbar-identity class (user-facing
        // request path — tighter than the bot's 8s/30s classes); the
        // route-level 8s watchdog stays the backstop.
        const runLiveCheck = (): Promise<boolean | null> => {
          if (deps.checkBanned) return deps.checkBanned(targetSteamId);
          return import('../watch/banCheck').then((m) =>
            m.isSteamTargetBanned(targetSteamId, 4000),
          );
        };
        const verdict: boolean | null = await singleFlightLiveCheck(
          targetSteamId,
          runLiveCheck,
        );
        if (verdict !== null) {
          // Cache the sighting (fail-open: a persist failure only means
          // the NEXT open re-checks live — the sweep baseline still
          // guarantees no false alert either way).
          try {
            const markChecked = deps.markChecked ?? markBanTargetChecked;
            await markChecked(targetSteamId, verdict);
          } catch (persistError) {
            logger.error(
              `[BanWatch] sighting persist failed (fail-open): target=${targetSteamId}: ${
                persistError instanceof Error
                  ? persistError.message
                  : String(persistError)
              }`,
            );
          }
          alreadyBanned = verdict;
        }
      }
    } catch (error) {
      logger.error(
        `[BanWatch] already-banned check failed (fail-open): target=${targetSteamId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      alreadyBanned = false;
    }

    const { created } = await create(
      subscriberSteamId,
      targetSteamId,
      searchId,
      alreadyBanned,
    );
    return { subscribed: true, created };
  } catch (error) {
    logger.error(
      `[BanWatch] subscribe hook failed: subscriber=${subscriberSteamId} searchId=${searchId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { subscribed: false, reason: 'error' };
  }
};
