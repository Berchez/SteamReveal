/**
 * Ban Reveal alert poller — consumes queued ban_alert events (enqueued by
 * the ban sweep's fan-out) and sends the generic Steam chat message.
 *
 * Single pass (`pollBanAlertQueueOnce`, exported for tests and for the
 * explicit first pass in index.ts) + interval driver (`startBanAlertPoller`).
 * Modeled directly on welcomePoller.ts (overlap guard, isConnected gate,
 * per-row isolation, settle-with-retry bookkeeping) with ban-specific gates:
 *
 * - Recipient still valid: the subscription row must still exist (no
 *   unsubscribe path in Phase 1, so in practice this only guards against a
 *   row deleted by a future admin action) — missing row drops loudly.
 * - Friendship-gates-chat-delivery (same constraint as every other lane):
 *   a subscriber who is not currently a bot friend gets NO chat send —
 *   the event drops, but the alert REMAINS visible in the web inbox (the
 *   inbox reads subscriptions, not outbox delivery state — chat delivery
 *   and inbox visibility are deliberately not the same guarantee).
 * - No TTL, DELIBERATELY like welcomes (unlike notifies): a ban verdict is
 *   durable news, so late delivery after bot downtime is still correct.
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond chat.sendFriendMessage — the structural
 * client type below is the entire Steam surface it needs.
 */

import withTimeout from '../lib/withTimeout';

import type { WatchBotLogger } from './logger';
import {
  sendBanAlertMessage,
  type BanAlertChatClient,
} from './banAlertMessage';

export interface BanAlertQueueEvent {
  id: number;
  steamId: string;
}

export interface BanAlertPollerDal {
  claimNextQueuedEvents: (
    kind: 'ban_alert',
    limit: number,
  ) => Promise<BanAlertQueueEvent[]>;
  markEventSent: (id: number) => Promise<boolean>;
  markEventDropped: (id: number) => Promise<boolean>;
  recordEventAttempt: (
    id: number,
    maxAttempts: number,
  ) => Promise<'requeued' | 'dropped' | null>;
  /**
   * Still-subscribed check. There is no unsubscribe path in Phase 1, so a
   * null result only guards against a row deleted by a future admin
   * action — drop loudly, never message.
   */
  getBanSubscriptionForAlert: (subscriberSteamId: string) => Promise<{
    locale: string | null;
  } | null>;
}

export interface BanAlertPollReport {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  errors: Array<{ eventId: number; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skipped: boolean;
}

export interface PollBanAlertQueueOptions {
  chat: BanAlertChatClient;
  dal: BanAlertPollerDal;
  logger?: WatchBotLogger;
  batchLimit?: number;
  maxAttempts?: number;
  /** Watchdog for a single sendFriendMessage call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL (no attempts burned).
   */
  isConnected?: () => boolean;
  /** Friendship-gates-chat: non-friends drop the chat send (inbox stays). */
  isFriend: (steamId: string) => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 30000;
// Settle retries after a successful send: a single DB timeout blip must
// not manufacture a duplicate message (or a lost one) for free.
const SETTLE_RETRIES = 3;

const settleSentWithRetry = async (
  dal: BanAlertPollerDal,
  eventId: number,
  attemptsLeft: number = SETTLE_RETRIES,
): Promise<boolean> => {
  try {
    // A false return (row left 'claimed' state) is NOT retried: retrying
    // cannot help, and the caller must not count it as sent.
    if (await dal.markEventSent(eventId)) return true;
    return false;
  } catch (error) {
    if (attemptsLeft <= 1) throw error;
    return settleSentWithRetry(dal, eventId, attemptsLeft - 1);
  }
};

export const pollBanAlertQueueOnce = async (
  options: PollBanAlertQueueOptions,
): Promise<BanAlertPollReport> => {
  const {
    chat,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    isConnected,
    isFriend,
  } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid ban-alert poller maxAttempts: expected positive integer',
    );
  }

  const startedAt = Date.now();
  const report: BanAlertPollReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dropped: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] ban-alert poll skipped (not connected to Steam)');
    return { ...report, skipped: true };
  }

  const events = await dal.claimNextQueuedEvents('ban_alert', batchLimit);
  report.claimed = events.length;

  const dropEvent = async (
    event: BanAlertQueueEvent,
    reason: string,
  ): Promise<void> => {
    // A drop that fails to land (row left 'claimed' under us) is loud but
    // not fatal: the stale sweep requeues it and the gates re-evaluate.
    // eslint-disable-next-line no-await-in-loop
    const settled = await dal.markEventDropped(event.id);
    if (settled) {
      report.dropped += 1;
      logger.info(
        `[WatchBot] ban-alert dropped: steamId=${event.steamId} eventId=${event.id} reason=${reason}`,
      );
    } else {
      report.errors.push({
        eventId: event.id,
        message: `drop did not land (not claimed anymore): ${reason}`,
      });
    }
  };

  const recordFailure = async (
    event: BanAlertQueueEvent,
    message: unknown,
  ): Promise<void> => {
    const text = message instanceof Error ? message.message : String(message);
    try {
      // eslint-disable-next-line no-await-in-loop
      const outcome = await dal.recordEventAttempt(event.id, maxAttempts);
      if (outcome === 'dropped') {
        report.dropped += 1;
        logger.error(
          `[WatchBot] ban-alert to ${event.steamId} dropped after ${maxAttempts} attempts: ${text}`,
        );
      } else if (outcome === 'requeued') {
        report.retried += 1;
      } else {
        // Row vanished mid-flight — visible, not silent.
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

  const processEvent = async (event: BanAlertQueueEvent): Promise<void> => {
    let recipient: Awaited<
      ReturnType<BanAlertPollerDal['getBanSubscriptionForAlert']>
    >;
    try {
      recipient = await dal.getBanSubscriptionForAlert(event.steamId);
    } catch (error) {
      // DAL read failed: do NOT drop (the recipient may be fine — the
      // database is what's sick). Requeue via the attempt counter.
      await recordFailure(event, error);
      return;
    }
    if (recipient === null) {
      await dropEvent(event, 'subscription-gone');
      return;
    }

    if (!isFriend(event.steamId)) {
      // Friendship gates CHAT delivery only: the web inbox reads the
      // subscription row (already notified), so the alert stays visible
      // there. Drop the chat send loudly — never retry a non-friend
      // (friendship may arrive days later, and a TTL-less requeue would
      // spin until the cap for nothing).
      await dropEvent(event, 'not-friend-yet');
      return;
    }

    // Locale comes from the recipient check (watch row first, account
    // fallback — resolved DAL-side, since the subscriber may never have a
    // watch row of their own).
    const { locale } = recipient;

    let messageSent = false;
    try {
      await withTimeout(
        sendBanAlertMessage(chat, event.steamId, locale),
        `banAlertPoller: sendFriendMessage(${event.steamId})`,
        sendTimeoutMs,
      );
      messageSent = true;
      const settled = await settleSentWithRetry(dal, event.id);
      if (!settled) {
        throw new Error('event left claimed state before settle');
      }
      report.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (messageSent) {
        // sendFriendMessage SUCCEEDED but the bookkeeping never landed: do
        // NOT call recordEventAttempt (it would requeue and re-send). Loud
        // error + errors[] entry; the row stays claimed and
        // resetStaleClaims requeues it in ~30min as a last resort.
        logger.error(
          `[WatchBot] ban-alert sent to ${event.steamId} but not recorded: ${message}`,
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
  // rate-sensitive, and determinism beats throughput here. Known N+1
  // shape: the recipient check costs ~2 DB round-trips per event
  // (subscription existence + locale). Acceptable at Phase-1 volume
  // (~1 subscription/day, batch cap 10 per 60s pass) — revisit with a
  // batched recipient read if the subscriber base ever grows two orders
  // of magnitude.
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
    `[WatchBot] ban-alert poll done: claimed=${report.claimed} sent=${report.sent} ` +
      `retried=${report.retried} dropped=${report.dropped} ` +
      `errors=${report.errors.length} durationMs=${report.durationMs}`,
  );
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of report.errors) {
    logger.error(
      `[WatchBot] ban-alert poll error: eventId=${entry.eventId} message=${entry.message}`,
    );
  }

  return report;
};

export interface BanAlertPollerHandle {
  stop: () => void;
  pollOnce: () => Promise<BanAlertPollReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly) so startup ordering stays visible at the call site. Timer is
 * unref'd like every other lane: the Steam connection owns process
 * lifetime, not the poller.
 */
export const startBanAlertPoller = (
  options: PollBanAlertQueueOptions & { pollIntervalMs: number },
): BanAlertPollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid ban-alert poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers:
  // a pass slower than the interval must not stack a second concurrent pass.
  let running = false;
  const pollOnce = async (): Promise<BanAlertPollReport> => {
    if (running) {
      logger.info(
        '[WatchBot] ban-alert poll skipped (previous pass still running)',
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
      return await pollBanAlertQueueOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] ban-alert poll pass failed: ${
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
