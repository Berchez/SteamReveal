/**
 * Watch Bot confirm-resend poller — fulfills on-demand "generate a new
 * link" requests (enqueued by POST /api/auth/confirm-resend) by issuing a
 * FRESH token and delivering it over Steam chat.
 *
 * Single pass (`pollConfirmResendQueueOnce`, exported for tests and for
 * the explicit first pass in index.ts) + interval driver
 * (`startConfirmResendPoller`). Full outbox-lane harness (overlap guard,
 * isConnected gate, per-row isolation, settle-with-retry bookkeeping,
 * attempt-capped drops) mirroring invite/notify, with resend-specific
 * fulfillment gates:
 *
 * - Recipient: the watched_profiles row must still exist AND be pending
 *   (active watches need no link; gone rows mean opt-out) — else drop.
 * - Account: must exist and be unconfirmed (clicked meanwhile, or a row
 *   that never signed up) — else drop. The confirm route owns everything
 *   from a click on, so a concurrent confirmation always wins over a
 *   re-issue here.
 * - Friendship: the bot can only message friends — else drop (reconcile
 *   removes such rows anyway).
 * - Throttle: re-issue only when no token is live, or the live one is
 *   older than resendMinIntervalMs (issue time derives from
 *   expires_at − confirmTokenTtlMs; corrupt clocks fail open toward
 *   re-issue, which heals the row). Without a floor, Start-spam would
 *   chat-spam: each issue kills the previous link, so the throttle is the
 *   only cost of a re-issue, and it must be bounded at this sink.
 *
 * Single-writer invariant preserved: the SITE never issues tokens (the
 * resend route only enqueues the request) — this poller is the sole
 * issuer alongside the friendship-accept path, and issueConfirmToken
 * overwrites, so at most one link is ever outstanding no matter how the
 * request and the accept race.
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond chat.sendFriendMessage — the structural
 * client type below is the entire Steam surface it needs, which is also
 * what makes it trivially fakeable in tests.
 */

import withTimeout from '../lib/withTimeout';
import { generateHexToken } from '../lib/watch/tokens';
import { hashConfirmToken } from '../lib/analytics/db';
import type { WatchAccount } from '../lib/analytics/types';

import type { WatchBotLogger } from './logger';
import {
  sendConfirmMessage,
  type NotifyChatClient,
} from './notifyMessage';

export interface ConfirmResendQueueEvent {
  id: number;
  steamId: string;
}

export interface ConfirmResendPollerDal {
  claimNextQueuedEvents: (
    kind: 'confirm_resend',
    limit: number,
  ) => Promise<ConfirmResendQueueEvent[]>;
  markEventSent: (id: number) => Promise<boolean>;
  markEventDropped: (id: number) => Promise<boolean>;
  recordEventAttempt: (
    id: number,
    maxAttempts: number,
  ) => Promise<'requeued' | 'dropped' | null>;
  /**
   * Still-pending recipient check. Only pending watches can need a link:
   * active watches are confirmed by construction (click-to-activate), and
   * gone rows mean opt-out.
   */
  getWatchedProfile: (steamId: string) => Promise<{
    status: string;
    locale: string | null;
  } | null>;
  getAccount: (steamId: string) => Promise<WatchAccount | null>;
  /**
   * Token arming (sole issuer alongside the friendship-accept path —
   * overwrite semantics keep a single outstanding link). Routed through
   * the DAL interface (not imported directly) so unit tests never touch
   * a real database.
   */
  issueConfirmToken: (
    steamId: string,
    tokenHash: string,
    expiresAt: string,
  ) => Promise<boolean>;
}

export interface ConfirmResendReport {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  errors: Array<{ eventId: number; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skipped: boolean;
}

export interface PollConfirmResendQueueOptions {
  chat: NotifyChatClient;
  dal: ConfirmResendPollerDal;
  logger?: WatchBotLogger;
  batchLimit?: number;
  maxAttempts?: number;
  /** Watchdog for a single sendFriendMessage call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /**
   * Public site base URL (no trailing slash) for the confirm link.
   * REQUIRED, no fallback: a resend link for the wrong environment
   * points at tokens that do not exist there (same rationale as the
   * bot config's siteUrl).
   */
  siteUrl: string;
  /** Confirm-link lifetime in ms (derives issue time from expires_at). */
  confirmTokenTtlMs: number;
  /** Minimum gap between two issues for one profile (spam bound). */
  resendMinIntervalMs?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL (no attempts burned).
   */
  isConnected?: () => boolean;
  /**
   * Friendship check (REQUIRED, no default): without it the poller would
   * attempt chat sends to non-friends (which fail) instead of dropping
   * rows reconcile is about to remove anyway.
   */
  isFriend: (steamId: string) => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 30000;
const DEFAULT_RESEND_MIN_INTERVAL_MS = 3600000;

// Settle retries after a successful send: a single DB timeout blip must
// not manufacture a duplicate message (or a lost one) for free.
const SETTLE_RETRIES = 3;

const settleSentWithRetry = async (
  dal: ConfirmResendPollerDal,
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

export const pollConfirmResendQueueOnce = async (
  options: PollConfirmResendQueueOptions,
): Promise<ConfirmResendReport> => {
  const {
    chat,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    siteUrl,
    confirmTokenTtlMs,
    resendMinIntervalMs = DEFAULT_RESEND_MIN_INTERVAL_MS,
    isConnected,
    isFriend,
  } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid resend poller maxAttempts: expected positive integer',
    );
  }
  if (typeof siteUrl !== 'string' || siteUrl === '') {
    throw new Error(
      'Invalid resend poller siteUrl: expected non-empty string',
    );
  }

  const startedAt = Date.now();
  const report: ConfirmResendReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dropped: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] resend poll skipped (not connected to Steam)');
    return { ...report, skipped: true };
  }

  const events = await dal.claimNextQueuedEvents('confirm_resend', batchLimit);
  report.claimed = events.length;

  const dropEvent = async (
    event: ConfirmResendQueueEvent,
    reason: string,
  ): Promise<void> => {
    // A drop that fails to land (row left 'claimed' under us) is loud but
    // not fatal: the stale sweep requeues it and the gates re-evaluate.
    // eslint-disable-next-line no-await-in-loop
    const settled = await dal.markEventDropped(event.id);
    if (settled) {
      report.dropped += 1;
      logger.info(
        `[WatchBot] resend dropped: steamId=${event.steamId} eventId=${event.id} reason=${reason}`,
      );
    } else {
      report.errors.push({
        eventId: event.id,
        message: `drop did not land (not claimed anymore): ${reason}`,
      });
    }
  };

  const recordFailure = async (
    event: ConfirmResendQueueEvent,
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
          `[WatchBot] resend to ${event.steamId} dropped after ${maxAttempts} attempts: ${text}`,
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

  // One event, fully handled: gates first (recipient, account,
  // friendship, throttle), then issue + send with settle bookkeeping.
  // Early returns replace `continue` (no-continue is on in this repo);
  // the caller awaits these one at a time, so per-row sequentiality is
  // preserved.
  const processEvent = async (
    event: ConfirmResendQueueEvent,
  ): Promise<void> => {
    let profile: Awaited<
      ReturnType<ConfirmResendPollerDal['getWatchedProfile']>
    >;
    let account: WatchAccount | null;
    try {
      // The two reads are independent: run them together (same precedent
      // as the notify sender's parallel nickname/token awaits).
      [profile, account] = await Promise.all([
        dal.getWatchedProfile(event.steamId),
        dal.getAccount(event.steamId),
      ]);
    } catch (error) {
      // DAL read failed: do NOT drop (the recipient may be fine — the
      // database is what's sick). Requeue via the attempt counter so a
      // later pass retries; a persistently sick DB drops it at the cap
      // instead of spinning forever.
      await recordFailure(event, error);
      return;
    }
    if (profile === null || profile.status !== 'pending') {
      await dropEvent(
        event,
        profile === null ? 'watch-gone' : 'watch-not-pending',
      );
      return;
    }
    if (account === null || account.confirmedAt !== null) {
      // Clicked meanwhile (confirm route owns activation + welcome now),
      // or a row that never signed up: nothing to re-issue, ever.
      await dropEvent(
        event,
        account === null ? 'no-account' : 'already-confirmed',
      );
      return;
    }
    if (!isFriend(event.steamId)) {
      // Not friends (or the friends list simply hasn't loaded yet right
      // after a reconnect): do NOT drop — this is an explicit user request
      // ("generate a new link"), and dropping it on a transient would lose
      // the request silently. Requeue via the attempt counter so a later
      // pass retries; a genuine unfriend drops at the cap (reconcile
      // removes those rows anyway, and the next pass then drops watch-gone
      // instead). Same pattern as a DAL read failure above.
      await recordFailure(event, 'not-friend-yet');
      return;
    }
    // Throttle: re-issue only when no token is live, or the live one is
    // older than the floor (issue time derives from expires_at − TTL).
    // Derivation-robustness note: if BOT_CONFIRM_TOKEN_TTL_MS ever changes
    // while tokens are outstanding, the computed issue time skews — but
    // both skew directions fail SAFE here (a too-new estimate throttles,
    // a too-old one sends one extra chat message), never insecure: the
    // throttle bounds spam volume, it does not authorize anything (the
    // friendship + unconfirmed gates above do that). Hence no issued_at
    // column — the derivation is sufficient for a spam bound.
    // Without a floor, Start-spam would chat-spam — this is the sink-side
    // bound that makes "generate a new link" unconditionally safe to offer.
    if (
      account.confirmTokenHash !== null &&
      account.confirmExpiresAt !== null
    ) {
      const issuedMs =
        Date.parse(account.confirmExpiresAt) - confirmTokenTtlMs;
      if (Number.isFinite(issuedMs) && Date.now() - issuedMs < resendMinIntervalMs) {
        await dropEvent(event, 'throttled');
        return;
      }
    }

    let messageSent = false;
    try {
      // Single writer (alongside the friendship-accept path): overwrite
      // semantics keep at most one link outstanding no matter how the
      // request and the accept race. A false return means the user
      // confirmed concurrently — drop quietly, the confirm route owns
      // activation + welcome from there.
      const token = generateHexToken();
      const issued = await dal.issueConfirmToken(
        event.steamId,
        hashConfirmToken(token),
        new Date(Date.now() + confirmTokenTtlMs).toISOString(),
      );
      if (!issued) {
        await dropEvent(event, 'confirmed-race');
        return;
      }
      // Watchdog: a hung sendFriendMessage (network stall, lib bug) must
      // fail visibly instead of wedging this pass. Only the recipient id
      // is interpolated into the label — never message text.
      await withTimeout(
        sendConfirmMessage(
          chat,
          event.steamId,
          profile.locale ?? account.locale ?? null,
          `${siteUrl.replace(/\/+$/, '')}/api/watch/confirm?token=${token}`,
        ),
        `confirmResendPoller: sendFriendMessage(${event.steamId})`,
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
          `[WatchBot] resend sent to ${event.steamId} but not recorded: ${message}`,
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
    `[WatchBot] resend poll done: claimed=${report.claimed} sent=${report.sent} ` +
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
      `[WatchBot] resend poll error: eventId=${entry.eventId} message=${entry.message}`,
    );
  }

  return report;
};

export interface ConfirmResendPollerHandle {
  stop: () => void;
  pollOnce: () => Promise<ConfirmResendReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring the heartbeat beat() pattern) so startup ordering
 * stays visible at the call site. Timer is unref'd like the heartbeat's:
 * the Steam connection owns process lifetime, not the poller.
 */
export const startConfirmResendPoller = (
  options: PollConfirmResendQueueOptions & { pollIntervalMs: number },
): ConfirmResendPollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid resend poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through the returned pollOnce):
  // a pass slower than the interval must not stack a second concurrent pass
  // on top — concurrent chat bursts are exactly the throttling pattern this
  // service avoids. Skipped ticks are not lost work: unclaimed rows wait
  // for the next tick.
  let running = false;
  const pollOnce = async (): Promise<ConfirmResendReport> => {
    if (running) {
      logger.info(
        '[WatchBot] resend poll skipped (previous pass still running)',
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
      return await pollConfirmResendQueueOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] resend poll pass failed: ${
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
