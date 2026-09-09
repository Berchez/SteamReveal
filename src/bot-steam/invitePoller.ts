/**
 * Watch Bot invite poller (WB-7) — consumes queued invite events and sends
 * real Steam friend invitations.
 *
 * Single pass (`pollInviteQueueOnce`, exported for tests and for the
 * explicit first pass in index.ts) + interval driver (`startInvitePoller`).
 * Per-row isolation: one bad event never aborts the pass. Retry policy is
 * short and bounded — a transient addFriend failure requeues for the next
 * pass, and after maxAttempts the event is dropped with a loud log (a
 * permanently-failing invite, e.g. Steam-side throttling, must not spin
 * the poller forever).
 *
 * This module never sees credentials (no secrets in scope by construction)
 * and never touches Steam beyond client.addFriend — the structural client
 * type below is the entire Steam surface it needs, which is also what
 * makes it trivially fakeable in tests.
 */

import withTimeout from '../lib/withTimeout';

export interface InvitePollerClient {
  addFriend: (steamId: string) => Promise<unknown>;
}

export interface InvitePollerDal {
  claimNextQueuedEvents: (
    kind: 'invite',
    limit: number,
  ) => Promise<Array<{ id: number; steamId: string }>>;
  markEventSent: (id: number) => Promise<boolean>;
  recordEventAttempt: (
    id: number,
    maxAttempts: number,
  ) => Promise<'requeued' | 'dropped' | null>;
}

export interface InvitePollerLogger {
  info: (message: string) => void;
  error: (message: string) => void;
}

export interface InvitePollReport {
  claimed: number;
  sent: number;
  retried: number;
  dropped: number;
  errors: Array<{ eventId: number; message: string }>;
  durationMs: number;
  /** True when the pass did no work (overlap skip or not-connected skip). */
  skipped: boolean;
}

export interface PollInviteQueueOptions {
  client: InvitePollerClient;
  dal: InvitePollerDal;
  logger?: InvitePollerLogger;
  batchLimit?: number;
  maxAttempts?: number;
  /** Watchdog for a single addFriend call (a hang must fail visibly). */
  sendTimeoutMs?: number;
  /**
   * Liveness gate: when provided and false, the pass is skipped without
   * touching Steam or the DAL (no attempts burned). This is what keeps the
   * boot-time first pass — fired before logon completes — from consuming
   * invite attempts it could never fulfill.
   */
  isConnected?: () => boolean;
}

const DEFAULT_BATCH_LIMIT = 10;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_SEND_TIMEOUT_MS = 30000;
// Settle retries after a successful send: a single DB timeout blip must
// not manufacture a duplicate invite (or a lost one) for free.
const SETTLE_RETRIES = 3;

const settleSentWithRetry = async (
  dal: InvitePollerDal,
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

export const pollInviteQueueOnce = async (
  options: PollInviteQueueOptions,
): Promise<InvitePollReport> => {
  const {
    client,
    dal,
    logger = console,
    batchLimit = DEFAULT_BATCH_LIMIT,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
    isConnected,
  } = options;
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid invite poller maxAttempts: expected positive integer',
    );
  }

  const startedAt = Date.now();
  const report: InvitePollReport = {
    claimed: 0,
    sent: 0,
    retried: 0,
    dropped: 0,
    errors: [],
    durationMs: 0,
    skipped: false,
  };

  if (isConnected !== undefined && !isConnected()) {
    logger.info('[WatchBot] invite poll skipped (not connected to Steam)');
    return { ...report, skipped: true };
  }

  const events = await dal.claimNextQueuedEvents('invite', batchLimit);
  report.claimed = events.length;

  // Sequential per-row awaits are intentional: invite sends are
  // Steam-side rate-sensitive, and determinism beats throughput here.
  // eslint-disable-next-line no-restricted-syntax
  for (const event of events) {
    let inviteSent = false;
    try {
      // Watchdog: a hung addFriend (network stall, lib bug) must fail
      // visibly instead of wedging this pass — and, once the overlap guard
      // below exists, a wedged pass would wedge the poller forever. Same
      // accepted limitation as everywhere withTimeout is used: the
      // underlying call is not aborted, only our wait for it.
      // eslint-disable-next-line no-await-in-loop
      await withTimeout(
        client.addFriend(event.steamId),
        `invitePoller: addFriend(${event.steamId})`,
        sendTimeoutMs,
      );
      inviteSent = true;
      // The send already happened: settling the bookkeeping must not route
      // through the failure path below (which would requeue and re-send).
      // Retry the mark itself a few times first — a single DB timeout
      // blip must not manufacture a duplicate invite.
      // eslint-disable-next-line no-await-in-loop
      const settled = await settleSentWithRetry(dal, event.id);
      if (!settled) {
        // The row left 'claimed' under us (e.g. a stale sweep requeued it
        // mid-send): the send DID happen but this worker no longer owns
        // the row. Count it as an error, never as sent — and do NOT
        // requeue (that would schedule a duplicate invite for sure).
        throw new Error('event left claimed state before settle');
      }
      report.sent += 1;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      if (inviteSent) {
        // addFriend SUCCEEDED but the bookkeeping never landed: do NOT
        // call recordEventAttempt (it would requeue and re-send). Loud
        // error + errors[] entry; the row stays claimed and resetStaleClaims
        // requeues it in ~30min as a last resort — a delayed duplicate
        // invite beats a silently lost one, and Steam dedupes pending
        // invites server-side in practice.
        logger.error(
          `[WatchBot] invite sent to ${event.steamId} but not recorded: ${message}`,
        );
        report.errors.push({
          eventId: event.id,
          message: `sent but not recorded: ${message}`,
        });
      } else {
        try {
          // eslint-disable-next-line no-await-in-loop
          const outcome = await dal.recordEventAttempt(event.id, maxAttempts);
          if (outcome === 'dropped') {
            report.dropped += 1;
            logger.error(
              `[WatchBot] invite to ${event.steamId} dropped after ${maxAttempts} attempts: ${message}`,
            );
          } else if (outcome === 'requeued') {
            report.retried += 1;
          } else {
            // Row vanished mid-flight (settled by nobody we know of) —
            // visible, not silent.
            report.errors.push({ eventId: event.id, message });
          }
        } catch (inner) {
          // bookkeeping itself failed (DB down): the event stays claimed and
          // resetStaleClaims requeues it later. Count loudly, move on.
          report.errors.push({
            eventId: event.id,
            message: inner instanceof Error ? inner.message : String(inner),
          });
        }
      }
    }
  }

  report.durationMs = Date.now() - startedAt;
  if (report.claimed === 0) {
    // Quiet on empty passes: a line per minute 24/7 is noise, and liveness
    // is the heartbeat's job, not the poller's.
    return report;
  }
  logger.info(
    `[WatchBot] invite poll done: claimed=${report.claimed} sent=${report.sent} ` +
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
      `[WatchBot] invite poll error: eventId=${entry.eventId} message=${entry.message}`,
    );
  }

  return report;
};

export interface InvitePollerHandle {
  stop: () => void;
  pollOnce: () => Promise<InvitePollReport>;
}

/**
 * Interval driver. Does NOT run an immediate pass (index.ts calls pollOnce
 * explicitly, mirroring the heartbeat beat() pattern) so startup ordering
 * stays visible at the call site. Timer is unref'd like the heartbeat's:
 * the Steam connection owns process lifetime, not the poller.
 */
export const startInvitePoller = (
  options: PollInviteQueueOptions & { pollIntervalMs: number },
): InvitePollerHandle => {
  const { pollIntervalMs, logger = console } = options;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs <= 0) {
    throw new Error(
      'Invalid invite poller interval: expected positive milliseconds',
    );
  }

  // Overlap guard, shared by the interval ticks AND external callers
  // (index.ts fires the first pass directly through the returned pollOnce):
  // a pass slower than the interval must not stack a second concurrent pass
  // on top — concurrent addFriend bursts are exactly the throttling pattern
  // this service avoids. Skipped ticks are not lost work: unclaimed rows
  // wait for the next tick.
  let running = false;
  const pollOnce = async (): Promise<InvitePollReport> => {
    if (running) {
      logger.info(
        '[WatchBot] invite poll skipped (previous pass still running)',
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
      return await pollInviteQueueOnce(options);
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    pollOnce().catch((error: unknown) => {
      logger.error(
        `[WatchBot] invite poll pass failed: ${
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
