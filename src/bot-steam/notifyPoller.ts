/**
 * Watch Bot notify poller (WB-13) — consumes queued notify events and sends
 * real Steam chat messages to the watching users.
 *
 * Single pass (`pollNotifyQueueOnce`, exported for tests and for the
 * explicit first pass in index.ts) + interval driver (`startNotifyPoller`).
 * Mirrors the invite poller's structure (overlap guard, isConnected gate,
 * per-row isolation, settle-with-retry bookkeeping) with notify-specific
 * pre-send gates:
 *
 * - TTL: events older than ttlDays (persisted created_at, never the local
 *   clock alone) are dropped, never sent — a bot offline for days must not
 *   wake up to a week of stale pings.
 * - Recipient: the watched_profiles row must still exist AND be active.
 *   Opt-out deletes the row while events survive (no FK by design), so a
 *   missing/non-active row means "do not message this user" — drop loudly
 *   instead of pointlessly failing chat sends to a non-friend.
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond chat.sendFriendMessage — the structural
 * client type below is the entire Steam surface it needs, which is also
 * what makes it trivially fakeable in tests.
 *
 * Throughput ceiling (known debt, same class as the ~250-friends-per-bot
 * note): strictly sequential sends cap delivery at batchLimit messages
 * per pollIntervalMs. Fine at current watch counts; if active watches
 * grow 10x, tune batch/interval (or shard bots) before touching this
 * loop — the sequentiality itself is the Steam-throttling protection.
 */

import withTimeout from '../lib/withTimeout';
import { NOTIFY_COOLDOWN_HOURS } from '../lib/analytics/watchNotify';
import isWithinCooldownWindow from '../lib/watch/cooldown';

import type { WatchBotLogger } from './logger';
import { sendNotifyMessage, type NotifyChatClient } from './notifyMessage';

export interface NotifyQueueEvent {
  id: number;
  steamId: string;
  createdAt: string;
}

export interface NotifyPollerDal {
  claimNextQueuedEvents: (
    kind: 'notify',
    limit: number,
  ) => Promise<NotifyQueueEvent[]>;
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
    lastNotifiedAt: string | null;
  } | null>;
}

export interface NotifyPollReport {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  errors: Array<{ eventId: number; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skipped: boolean;
}

export interface PollNotifyQueueOptions {
  chat: NotifyChatClient;
  dal: NotifyPollerDal;
  logger?: WatchBotLogger;
  batchLimit?: number;
  maxAttempts?: number;
  /** Watchdog for a single sendFriendMessage call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /** Events older than this (by persisted created_at) are dropped unsent. */
  ttlDays?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL (no attempts burned). This is what keeps the
   * boot-time first pass — fired before logon completes — from consuming
   * notify attempts it could never fulfill.
   */
  isConnected?: () => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 30000;
const DEFAULT_TTL_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
// Settle retries after a successful send: a single DB timeout blip must
// not manufacture a duplicate message (or a lost one) for free.
const SETTLE_RETRIES = 3;

/**
 * Send-time cooldown recheck (P1-2): the enqueue gate alone cannot keep the
 * "max 1 notify / 24h" promise — a burst of searches queues several events
 * before any of them sends, and without this check the same pass would
 * deliver all of them minutes apart. Evaluated against the
 * last_notified_at already fetched with the profile (no extra query; read
 * seconds ago in the same sequential pass, so no staleness concern — and
 * the overlap guard guarantees a single pass at a time anyway).
 * Fail-open like the DAL isWithinCooldown: missing/corrupt clocks never
 * suppress notifications forever. Timestamp math lives in the shared
 * @/lib/watch/cooldown module (same predicate as the enqueue gate).
 */

/**
 * True when the event is older than ttlDays by its persisted created_at.
 * A corrupt/unparseable timestamp expires too: the alternative (sending a
 * possibly-ancient notify) is the harmful direction for an
 * unsolicited-message product, and dropping advances no cooldown, so a
 * fresh search re-enqueues cleanly (self-healing, never a silent dead).
 */
export const isNotifyExpired = (
  createdAt: string,
  ttlDays: number,
  nowMs: number = Date.now(),
): boolean => {
  const createdMs = Date.parse(createdAt);
  if (!Number.isFinite(createdMs)) return true;
  return nowMs - createdMs > ttlDays * MS_PER_DAY;
};

const settleSentWithRetry = async (
  dal: NotifyPollerDal,
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

export const pollNotifyQueueOnce = async (
  options: PollNotifyQueueOptions,
): Promise<NotifyPollReport> => {
  const {
    chat,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    ttlDays = DEFAULT_TTL_DAYS,
    isConnected,
  } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid notify poller maxAttempts: expected positive integer',
    );
  }
  if (!Number.isFinite(ttlDays) || ttlDays <= 0) {
    throw new Error('Invalid notify poller ttlDays: expected positive days');
  }

  const startedAt = Date.now();
  const report: NotifyPollReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dropped: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] notify poll skipped (not connected to Steam)');
    return { ...report, skipped: true };
  }

  const events = await dal.claimNextQueuedEvents('notify', batchLimit);
  report.claimed = events.length;

  const dropEvent = async (
    event: NotifyQueueEvent,
    reason: string,
  ): Promise<void> => {
    // A drop that fails to land (row left 'claimed' under us) is loud but
    // not fatal: the stale sweep requeues it and the gates re-evaluate.
    // eslint-disable-next-line no-await-in-loop
    const settled = await dal.markEventDropped(event.id);
    if (settled) {
      report.dropped += 1;
      logger.info(
        `[WatchBot] notify dropped: steamId=${event.steamId} eventId=${event.id} reason=${reason}`,
      );
    } else {
      report.errors.push({
        eventId: event.id,
        message: `drop did not land (not claimed anymore): ${reason}`,
      });
    }
  };

  const recordFailure = async (
    event: NotifyQueueEvent,
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
          `[WatchBot] notify to ${event.steamId} dropped after ${maxAttempts} attempts: ${text}`,
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

  // One event, fully handled: gates first (TTL, recipient), then the
  // send with settle bookkeeping. Early returns replace `continue`
  // (no-continue is on in this repo); the caller awaits these one at a
  // time, so per-row sequentiality is preserved.
  const processEvent = async (event: NotifyQueueEvent): Promise<void> => {
    if (isNotifyExpired(event.createdAt, ttlDays)) {
      await dropEvent(event, 'expired-ttl');
      return;
    }

    let profile: Awaited<ReturnType<NotifyPollerDal['getWatchedProfile']>>;
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
    if (isWithinCooldownWindow(profile.lastNotifiedAt, NOTIFY_COOLDOWN_HOURS)) {
      // A notify already went out inside the window (possibly an earlier
      // event in THIS pass — the clock advances on every markEventSent).
      // Drop: the product promise is max 1 message per 24h, and an extra
      // ping minutes after the first reads as bot spam (ban risk).
      await dropEvent(event, 'cooldown-suppressed');
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
        sendNotifyMessage(chat, event.steamId, profile.locale),
        `notifyPoller: sendFriendMessage(${event.steamId})`,
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
        // beats a silently lost one for a notification product.
        logger.error(
          `[WatchBot] notify sent to ${event.steamId} but not recorded: ${message}`,
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
    `[WatchBot] notify poll done: claimed=${report.claimed} sent=${report.sent} ` +
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
      `[WatchBot] notify poll error: eventId=${entry.eventId} message=${entry.message}`,
    );
  }

  return report;
};

export interface NotifyPollerHandle {
  stop: () => void;
  pollOnce: () => Promise<NotifyPollReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring the heartbeat beat() pattern) so startup ordering
 * stays visible at the call site. Timer is unref'd like the heartbeat's:
 * the Steam connection owns process lifetime, not the poller.
 */
export const startNotifyPoller = (
  options: PollNotifyQueueOptions & { pollIntervalMs: number },
): NotifyPollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid notify poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through the returned pollOnce):
  // a pass slower than the interval must not stack a second concurrent pass
  // on top — concurrent chat bursts are exactly the throttling pattern this
  // service avoids. Skipped ticks are not lost work: unclaimed rows wait
  // for the next tick.
  let running = false;
  const pollOnce = async (): Promise<NotifyPollReport> => {
    if (running) {
      logger.info(
        '[WatchBot] notify poll skipped (previous pass still running)',
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
      return await pollNotifyQueueOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] notify poll pass failed: ${
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
