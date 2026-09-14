/**
 * Watch Bot confirm-link expiry poller — sends the single "your link
 * expired, generate a new one on the site" notice per token generation.
 *
 * Single pass (`pollConfirmExpiryOnce`, exported for tests and for the
 * explicit first pass in index.ts) + interval driver
 * (`startConfirmExpiryPoller`). Scan-based, not an outbox lane: there is
 * nothing to claim (the DAL listing is the work queue), so the harness is
 * lighter than invite/notify — overlap guard, isConnected gate, per-row
 * isolation, no attempt counters (a failed send is simply retried next
 * pass by not marking; opt-out rows vanish via reconcile).
 *
 * THE correctness property ("only if they really did not click"): the
 * listing is a point-in-time read, and a click can land between it and
 * the chat send. So every candidate is RE-CHECKED immediately before
 * sending (same generation still pending?) and the mark itself is a
 * conditional write (concurrent click wins the predicate). Residual
 * window: a click landing in the milliseconds between recheck and send
 * still delivers a stale nag — physically unavoidable without a
 * distributed lock, cosmetic (the watch still activates; the message is
 * ignorable), and disclosed here rather than hidden. Never the reverse:
 * a click that landed before the recheck can never produce a message.
 *
 * Send-then-mark order is deliberate: marking first and crashing would
 * strand the user in permanent silence (noticed without delivery, never
 * retried); sending first risks at most a duplicate nag on crash
 * (at-least-once, the house tradeoff for user-facing messages).
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond chat.sendFriendMessage — the structural
 * client type below is the entire Steam surface it needs, which is also
 * what makes it trivially fakeable in tests.
 */

import withTimeout from '../lib/withTimeout';
import type {
  ExpiredConfirmCandidate,
  WatchAccount,
} from '../lib/analytics/types';

import type { WatchBotLogger } from './logger';
import {
  sendConfirmExpiredMessage,
  type NotifyChatClient,
} from './notifyMessage';

export interface ConfirmExpiryPollerDal {
  listExpiredUnnoticedConfirms: (
    limit: number,
  ) => Promise<ExpiredConfirmCandidate[]>;
  getAccount: (steamId: string) => Promise<WatchAccount | null>;
  markExpireNoticed: (steamId: string, expiresAt: string) => Promise<boolean>;
}

export interface ConfirmExpiryReport {
  checked: number;
  notified: number;
  skipped: number;
  errors: Array<{ steamId: string; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skippedPass: boolean;
}

export interface PollConfirmExpiryOptions {
  chat: NotifyChatClient;
  dal: ConfirmExpiryPollerDal;
  logger?: WatchBotLogger;
  batchLimit?: number;
  /** Watchdog for a single sendFriendMessage call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL.
   */
  isConnected?: () => boolean;
  /**
   * Friendship check (REQUIRED, no default): without it the poller would
   * attempt chat sends to non-friends (which fail) instead of skipping
   * rows reconcile is about to remove anyway. Wired in index.ts to the
   * live friends map.
   */
  isFriend: (steamId: string) => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_SEND_TIMEOUT_MS = 30000;

export const pollConfirmExpiryOnce = async (
  options: PollConfirmExpiryOptions,
): Promise<ConfirmExpiryReport> => {
  const {
    chat,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    isConnected,
    isFriend,
  } = options;

  const startedAt = Date.now();
  const report: ConfirmExpiryReport = {
    checked: 0,
    notified: 0,
    skipped: 0,
    errors: [],
    durationMs: 0,
    skippedPass: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] expiry scan skipped (not connected to Steam)');
    return { ...report, skippedPass: true };
  }

  const candidates = await dal.listExpiredUnnoticedConfirms(batchLimit);
  report.checked = candidates.length;

  // One candidate, fully handled: friendship, then the pre-send recheck
  // (THE click guarantee), then send, then the conditional mark. Early
  // returns replace `continue` (no-continue is on in this repo); the
  // caller awaits these one at a time, so per-row sequentiality holds.
  const processCandidate = async (
    candidate: ExpiredConfirmCandidate,
  ): Promise<void> => {
    const { steamId, expiresAt } = candidate;
    if (!isFriend(steamId)) {
      // No chat channel (and reconcile removes such rows anyway): stay
      // silent, counted but unlogged — hourly per-row noise otherwise.
      report.skipped += 1;
      return;
    }

    let account: WatchAccount | null;
    try {
      account = await dal.getAccount(steamId);
    } catch (error) {
      // DAL read failed: do NOT mark (nothing was verified) — the next
      // pass retries the same candidate.
      report.errors.push({
        steamId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (
      account === null ||
      account.confirmedAt !== null ||
      account.confirmExpiresAt !== expiresAt
    ) {
      // Clicked (confirmed/token cleared), or a newer generation was
      // issued since the scan (its own expiry will surface separately):
      // the user did NOT abandon THIS link — never nag them about it.
      report.skipped += 1;
      return;
    }

    // Message language mirrors the activation rule (watch row first,
    // signup account fallback — templates fall back to English past both).
    const locale = candidate.watchLocale ?? account.locale ?? null;
    try {
      // Watchdog: a hung sendFriendMessage must fail visibly instead of
      // wedging this pass. Only the recipient id is interpolated into the
      // label — never message text.
      await withTimeout(
        sendConfirmExpiredMessage(chat, steamId, locale),
        `confirmExpiryPoller: sendFriendMessage(${steamId})`,
        sendTimeoutMs,
      );
    } catch (error) {
      // Send failed: do NOT mark (the user got nothing) — the next pass
      // retries the same candidate.
      report.errors.push({
        steamId,
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    try {
      const marked = await dal.markExpireNoticed(steamId, expiresAt);
      if (!marked) {
        // A click won the race between our recheck and this write (token
        // cleared under us): the nag above is stale but harmless, and the
        // confirm route owns activation + welcome from here. Info, never
        // error — the user did exactly the right thing.
        logger.info(
          `[WatchBot] expiry notice raced by a click (already confirmed): steamId=${steamId}`,
        );
      }
      report.notified += 1;
    } catch (error) {
      // Message already delivered but the mark never landed: a later pass
      // may duplicate the nag (at-least-once, disclosed above). Loud, so
      // the duplicate — if the user reports one — is explainable.
      report.errors.push({
        steamId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Sequential per-row awaits are intentional: chat sends are Steam-side
  // rate-sensitive, and determinism beats throughput here.
  // eslint-disable-next-line no-restricted-syntax
  for (const candidate of candidates) {
    // eslint-disable-next-line no-await-in-loop
    await processCandidate(candidate);
  }

  report.durationMs = Date.now() - startedAt;
  if (report.checked === 0) {
    // Quiet on empty scans: hourly silence is the normal state, and
    // liveness is the heartbeat's job, not the poller's.
    return report;
  }
  logger.info(
    `[WatchBot] expiry scan done: checked=${report.checked} notified=${report.notified} ` +
      `skipped=${report.skipped} errors=${report.errors.length} ` +
      `durationMs=${report.durationMs}`,
  );
  // Sequential logging only; the disable mirrors the main loop below.
  // eslint-disable-next-line no-restricted-syntax
  for (const entry of report.errors) {
    logger.error(
      `[WatchBot] expiry scan error: steamId=${entry.steamId} message=${entry.message}`,
    );
  }

  return report;
};

export interface ConfirmExpiryPollerHandle {
  stop: () => void;
  pollOnce: () => Promise<ConfirmExpiryReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring the heartbeat beat() pattern) so startup ordering
 * stays visible at the call site. Timer is unref'd like the heartbeat's:
 * the Steam connection owns process lifetime, not the poller.
 */
export const startConfirmExpiryPoller = (
  options: PollConfirmExpiryOptions & { pollIntervalMs: number },
): ConfirmExpiryPollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid expiry poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through the returned pollOnce).
  let running = false;
  const pollOnce = async (): Promise<ConfirmExpiryReport> => {
    if (running) {
      logger.info(
        '[WatchBot] expiry scan skipped (previous pass still running)',
      );
      return {
        checked: 0,
        notified: 0,
        skipped: 0,
        errors: [],
        durationMs: 0,
        skippedPass: true,
      };
    }
    running = true;
    try {
      return await pollConfirmExpiryOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] expiry scan pass failed: ${
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
