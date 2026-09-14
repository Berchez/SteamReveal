/**
 * Watch Bot welcome poller — consumes queued welcome events (enqueued by
 * the confirm route's POST right after it activates a watch) and sends
 * the real Steam welcome chat message.
 *
 * Single pass (`pollWelcomeQueueOnce`, exported for tests and for the
 * explicit first pass in index.ts) + interval driver (`startWelcomePoller`).
 * Mirrors the notify poller's structure (overlap guard, isConnected gate,
 * per-row isolation, settle-with-retry bookkeeping) with welcome-specific
 * gates:
 *
 * - Recipient: the watched_profiles row must still exist AND be active.
 *   Opt-out deletes the row while events survive (no FK by design), so a
 *   missing row means "do not message" — drop loudly. A still-pending row
 *   can only occur via hand edits (the confirm route enqueues exclusively
 *   on activated===true; backstop activations welcome via onActivated
 *   instead) — also dropped loudly, never silently held.
 * - No TTL, DELIBERATELY unlike notifies: a welcome states durable status
 *   ("monitoring is active, unfriend to stop"), not time-sensitive news,
 *   so late delivery after bot downtime is still correct.
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond chat.sendFriendMessage — the structural
 * client type below is the entire Steam surface it needs, which is also
 * what makes it trivially fakeable in tests.
 */

import withTimeout from '../lib/withTimeout';

import type { WatchBotLogger } from './logger';
import {
  sendWelcomeMessage,
  type WelcomeChatClient,
} from './welcomeMessage';

export interface WelcomeQueueEvent {
  id: number;
  steamId: string;
}

export interface WelcomePollerDal {
  claimNextQueuedEvents: (
    kind: 'welcome',
    limit: number,
  ) => Promise<WelcomeQueueEvent[]>;
  markEventSent: (id: number) => Promise<boolean>;
  markEventDropped: (id: number) => Promise<boolean>;
  recordEventAttempt: (
    id: number,
    maxAttempts: number,
  ) => Promise<'requeued' | 'dropped' | null>;
  /**
   * Still-active recipient check. Opt-out deletes the profile row while
   * its events survive, so a null (or non-active) result is the normal
   * "user left" signal, not an error.
   */
  getWatchedProfile: (steamId: string) => Promise<{
    status: string;
    locale: string | null;
  } | null>;
}

export interface WelcomePollReport {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  errors: Array<{ eventId: number; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skipped: boolean;
}

export interface PollWelcomeQueueOptions {
  chat: WelcomeChatClient;
  dal: WelcomePollerDal;
  logger?: WatchBotLogger;
  batchLimit?: number;
  maxAttempts?: number;
  /** Watchdog for a single sendFriendMessage call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL (no attempts burned). This is what keeps the
   * boot-time first pass — fired before logon completes — from consuming
   * welcome attempts it could never fulfill.
   */
  isConnected?: () => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 30000;
// Settle retries after a successful send: a single DB timeout blip must
// not manufacture a duplicate message (or a lost one) for free.
const SETTLE_RETRIES = 3;

const settleSentWithRetry = async (
  dal: WelcomePollerDal,
  eventId: number,
  attemptsLeft: number = SETTLE_RETRIES,
): Promise<boolean> => {
  try {
    // A false return (row left 'claimed' state — e.g. requeued by a stale
    // sweep mid-send) is NOT retried: retrying cannot help, and the caller
    // must not count it as sent.
    if (await dal.markEventSent(eventId)) return true;
    return false;
  } catch (error) {
    if (attemptsLeft <= 1) throw error;
    return settleSentWithRetry(dal, eventId, attemptsLeft - 1);
  }
};

export const pollWelcomeQueueOnce = async (
  options: PollWelcomeQueueOptions,
): Promise<WelcomePollReport> => {
  const {
    chat,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    isConnected,
  } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid welcome poller maxAttempts: expected positive integer',
    );
  }

  const startedAt = Date.now();
  const report: WelcomePollReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dropped: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] welcome poll skipped (not connected to Steam)');
    return { ...report, skipped: true };
  }

  const events = await dal.claimNextQueuedEvents('welcome', batchLimit);
  report.claimed = events.length;

  const dropEvent = async (
    event: WelcomeQueueEvent,
    reason: string,
  ): Promise<void> => {
    // A drop that fails to land (row left 'claimed' under us) is loud but
    // not fatal: the stale sweep requeues it and the gates re-evaluate.
    // eslint-disable-next-line no-await-in-loop
    const settled = await dal.markEventDropped(event.id);
    if (settled) {
      report.dropped += 1;
      logger.info(
        `[WatchBot] welcome dropped: steamId=${event.steamId} eventId=${event.id} reason=${reason}`,
      );
    } else {
      report.errors.push({
        eventId: event.id,
        message: `drop did not land (not claimed anymore): ${reason}`,
      });
    }
  };

  const recordFailure = async (
    event: WelcomeQueueEvent,
    message: unknown,
  ): Promise<void> => {
    const text = message instanceof Error ? message.message : String(message);
    try {
      // await-in-loop is the poller's whole design (sequential per-row
      // awaits); the disable mirrors every other await in this function.
      // eslint-disable-next-line no-await-in-loop
      const outcome = await dal.recordEventAttempt(event.id, maxAttempts);
      if (outcome === 'dropped') {
        report.dropped += 1;
        logger.error(
          `[WatchBot] welcome to ${event.steamId} dropped after ${maxAttempts} attempts: ${text}`,
        );
      } else if (outcome === 'requeued') {
        report.retried += 1;
      } else {
        // Row vanished mid-flight (settled by nobody we know of) —
        // visible, not silent.
        report.errors.push({ eventId: event.id, message: text });
      }
    } catch (inner) {
      // bookkeeping itself failed (DB down): the event stays claimed and
      // resetStaleClaims requeues it later. Count loudly, move on.
      report.errors.push({
        eventId: event.id,
        message: inner instanceof Error ? inner.message : String(inner),
      });
    }
  };

  // One event, fully handled: gates first (recipient), then the send with
  // settle bookkeeping. Early returns replace `continue` (no-continue is
  // on in this repo); the caller awaits these one at a time, so per-row
  // sequentiality is preserved.
  const processEvent = async (event: WelcomeQueueEvent): Promise<void> => {
    let profile: Awaited<ReturnType<WelcomePollerDal['getWatchedProfile']>>;
    try {
      profile = await dal.getWatchedProfile(event.steamId);
    } catch (error) {
      // DAL read failed: do NOT drop (the recipient may be fine — the
      // database is what's sick). Requeue via the attempt counter so a
      // later pass retries; a persistently sick DB drops it at the cap
      // instead of spinning forever.
      await recordFailure(event, error);
      return;
    }
    if (profile === null || profile.status !== 'active') {
      await dropEvent(
        event,
        profile === null ? 'watch-gone' : 'watch-not-active',
      );
      return;
    }

    let messageSent = false;
    try {
      // Watchdog: a hung sendFriendMessage (network stall, lib bug) must
      // fail visibly instead of wedging this pass. Same accepted
      // limitation as everywhere withTimeout is used: the underlying call
      // is not aborted, only our wait for it. Only the recipient id is
      // interpolated into the label — never message text.
      await withTimeout(
        sendWelcomeMessage(chat, event.steamId, profile.locale),
        `welcomePoller: sendFriendMessage(${event.steamId})`,
        sendTimeoutMs,
      );
      messageSent = true;
      // The send already happened: settling the bookkeeping must not route
      // through the failure path below (which would requeue and re-send).
      // Retry the mark itself a few times first — a single DB timeout
      // blip must not manufacture a duplicate message.
      const settled = await settleSentWithRetry(dal, event.id);
      if (!settled) {
        // The row left 'claimed' under us (e.g. a stale sweep requeued it
        // mid-send): the send DID happen but this worker no longer owns
        // the row. Count it as an error, never as sent — and do NOT
        // requeue (that would schedule a duplicate message for sure).
        throw new Error('event left claimed state before settle');
      }
      report.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (messageSent) {
        // sendFriendMessage SUCCEEDED but the bookkeeping never landed: do
        // NOT call recordEventAttempt (it would requeue and re-send). Loud
        // error + errors[] entry; the row stays claimed and resetStaleClaims
        // requeues it in ~30min as a last resort — a delayed duplicate
        // beats a silently lost one for a confirmation product.
        logger.error(
          `[WatchBot] welcome sent to ${event.steamId} but not recorded: ${message}`,
        );
        report.errors.push({
          eventId: event.id,
          message: `sent but not recorded: ${message}`,
        });
      } else {
        await recordFailure(event, message);
      }
    }
  };

  // Sequential per-row awaits are intentional: chat sends are Steam-side
  // rate-sensitive, and determinism beats throughput here.
  // eslint-disable-next-line no-restricted-syntax
  for (const event of events) {
    // eslint-disable-next-line no-await-in-loop
    await processEvent(event);
  }

  report.durationMs = Date.now() - startedAt;
  if (report.claimed === 0) {
    // Quiet on empty passes: a line per minute 24/7 is noise, and liveness
    // is the heartbeat's job, not the poller's.
    return report;
  }
  logger.info(
    `[WatchBot] welcome poll done: claimed=${report.claimed} sent=${report.sent} ` +
      `retried=${report.retried} dropped=${report.dropped} ` +
      `errors=${report.errors.length} durationMs=${report.durationMs}`,
  );
  // The count above is not actionable (which event failed, and why?).
  // Log each failure individually so production debugging never needs a DB
  // dive just to learn what broke.
  // Sequential logging only; the disable mirrors the main loop below.
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of report.errors) {
    logger.error(
      `[WatchBot] welcome poll error: eventId=${entry.eventId} message=${entry.message}`,
    );
  }

  return report;
};

export interface WelcomePollerHandle {
  stop: () => void;
  pollOnce: () => Promise<WelcomePollReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring the heartbeat beat() pattern) so startup ordering
 * stays visible at the call site. Timer is unref'd like the heartbeat's:
 * the Steam connection owns process lifetime, not the poller.
 */
export const startWelcomePoller = (
  options: PollWelcomeQueueOptions & { pollIntervalMs: number },
): WelcomePollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid welcome poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through the returned pollOnce):
  // a pass slower than the interval must not stack a second concurrent pass
  // on top — concurrent chat bursts are exactly the throttling pattern this
  // service avoids. Skipped ticks are not lost work: unclaimed rows wait
  // for the next tick.
  let running = false;
  const pollOnce = async (): Promise<WelcomePollReport> => {
    if (running) {
      logger.info(
        '[WatchBot] welcome poll skipped (previous pass still running)',
      );
      return {
        claimed: 0,
        sent: 0,
        retried: 0,
        dropped: 0,
        errors: [],
        durationMs: 0,
        skipped: true,
      };
    }
    running = true;
    try {
      return await pollWelcomeQueueOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] welcome poll pass failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  }, pollIntervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return {
    stop: () => clearInterval(timer),
    pollOnce,
  };
};
