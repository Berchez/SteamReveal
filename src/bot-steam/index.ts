/**
 * Watch Bot entrypoint — `pnpm run start:bot`.
 *
 * Long-lived process (same model as src/proxy-local/server.ts, NOT Vercel
 * serverless): keeps one Steam session up, reconciles the friendsList
 * snapshot against watched_profiles on every (re)logon, and writes a
 * heartbeat file for scripts/healthcheck-bot.ts.
 *
 * Nothing in this file is imported by tests or by Next.js — it only runs
 * when executed directly.
 */
import SteamUser from 'steam-user';

import { loadEnv } from '../lib/env';
import {
  activateWatch,
  claimNextQueuedEvents,
  countInvitesSentSince,
  getAccount,
  getWatchedProfile,
  issueConfirmToken,
  listExpiredUnnoticedConfirms,
  listWatchedProfiles,
  markEventDropped,
  markEventSent,
  markExpireNoticed,
  recordEventAttempt,
  removeWatchAndAccount,
  resetStaleClaims,
} from '../lib/analytics/db';
import { loadBotConfig } from './config';
import type { WatchBotLogger } from './logger';
import { WatchBot } from './bot';
import { reconcileFriendsList } from './reconcile';
import { handleFriendRemoved } from './friendRemoved';
import {
  handleActivation,
  sendConfirmLink,
  type ActivationChatClient,
} from './activationMessage';
import type { NotifyChatClient } from './notifyMessage';
import type { WelcomeChatClient } from './welcomeMessage';
import { startHeartbeat } from './heartbeat';
import { startInvitePoller } from './invitePoller';
import { startNotifyPoller } from './notifyPoller';
import { startWelcomePoller } from './welcomePoller';
import { startConfirmExpiryPoller } from './confirmExpiryPoller';
import { startConfirmResendPoller } from './confirmResendPoller';
import { startStaleClaimSweeper, sweepStaleClaimsOnce } from './staleSweep';

loadEnv();

const main = (): void => {
  let config;
  try {
    config = loadBotConfig();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] invalid configuration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exit(1);
  }

  const client = new SteamUser({
    dataDirectory: config.dataDirectory,
    // The WatchBot class owns the single reconnect loop (capped exponential
    // backoff). The library default (autoRelogin: true) would run a SECOND
    // loop on top — disable it explicitly.
    autoRelogin: false,
  });

  // Single shared logger for the bot and all of its handlers (reconcile,
  // friend-remove, pollers): the opt-out audit trail must flow through the
  // same sink as everything else, so a future custom logger can be swapped
  // in exactly one place. Console today, by explicit choice.
  // eslint-disable-next-line no-console
  const logger: WatchBotLogger = console;

  // Declared before the bot: onConnected (below) fires the first invite
  // pass, so it needs the handle — assigned further down during the same
  // synchronous setup, long before any logon can complete.
  let invitePoller: ReturnType<typeof startInvitePoller> | undefined;
  let notifyPoller: ReturnType<typeof startNotifyPoller> | undefined;
  let welcomePoller: ReturnType<typeof startWelcomePoller> | undefined;
  let resendPoller: ReturnType<typeof startConfirmResendPoller> | undefined;
  let expiryPoller: ReturnType<typeof startConfirmExpiryPoller> | undefined;

  // Live friendship check for the confirm lanes (expiry scan + resend
  // fulfillment) and the periodic reconcile below: same authoritative map
  // the reconcile snapshots come from (bot.ts forwards {...myFriends}),
  // read directly so timer passes never depend on event delivery.
  const isFriend = (steamId: string): boolean =>
    client.myFriends[steamId] === SteamUser.EFriendRelationship.Friend;

  // Shared converge call so the event-driven snapshot path and the
  // periodic backstop below can never drift apart (same DAL, same hooks).
  // The cast is contained here: @types/steam-user does not declare
  // chat.sendFriendMessage (verified present at runtime in the
  // installed v5), so the structural chat-client type carries it.
  const convergeFriends = (friendsById: Record<string, number>): void => {
    reconcileFriendsList(
      friendsById,
      SteamUser.EFriendRelationship.Friend,
      {
        listWatchedProfiles,
        activateWatch,
        removeWatchAndAccount,
        getAccount,
      },
      logger,
      // Activation message (navbar-global signup flow, see
      // activationMessage.ts for the no-retry rationale). Runs after
      // activateWatch commits; a send failure is isolated per row by
      // reconcile (activation stands) and fires exactly once per
      // activation thanks to reconcile's serialized passes (a repeat
      // pass sees 'active' and skips).
      ({ steamId, locale }) => {
        const chat = client.chat as unknown as ActivationChatClient;
        return handleActivation(chat, steamId, locale, config);
      },
        // Confirm-link sender (click-to-activate flow): pending + friend +
        // unconfirmed accounts get the link WITHOUT activating — the
        // click (confirm route POST) is the sole activator. sendConfirmLink
        // issues only when no token was ever issued, so repeat passes
        // (every reconnect) do not spam chat; failures are isolated per
        // row like above.
      async ({ steamId, locale }) => {
        const chat = client.chat as unknown as ActivationChatClient;
        return sendConfirmLink(chat, steamId, locale, config);
      },
    ).catch((error) => {
      // eslint-disable-next-line no-console
      console.error(
        `[WatchBot] reconcile failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  };

  const bot = new WatchBot({
    client,
    accountName: config.accountName,
    password: config.password,
    sharedSecret: config.sharedSecret,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    logger,
    // reconcile() is async but the snapshot event is sync: a rejection
    // here must never become an unhandled rejection that kills the
    // process (reconcile already isolates per-row errors; this is the
    // last-resort guard for listWatchedProfiles-level failures).
    onFriendsSnapshot: (friendsById) => {
      convergeFriends(friendsById);
    },
    // Prompt first passes on every (re)logon instead of waiting for the
    // next interval ticks — queued work drains right after reconnects.
    // The pollers re-check connection themselves, so a stray call is a
    // safe no-op. INDEPENDENT guards (not one shared early return):
    // each lane must fire even if another handle is somehow unset.
    onConnected: () => {
      const invites = invitePoller;
      if (invites !== undefined) {
        invites.pollOnce().catch((error: unknown) =>
          // eslint-disable-next-line no-console
          console.error(
            `[WatchBot] post-logon invite poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      const welcomes = welcomePoller;
      if (welcomes !== undefined) {
        welcomes.pollOnce().catch((error: unknown) =>
          // eslint-disable-next-line no-console
          console.error(
            `[WatchBot] post-logon welcome poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      const resends = resendPoller;
      if (resends !== undefined) {
        resends.pollOnce().catch((error: unknown) =>
          // eslint-disable-next-line no-console
          console.error(
            `[WatchBot] post-logon resend poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      const expiries = expiryPoller;
      if (expiries !== undefined) {
        expiries.pollOnce().catch((error: unknown) =>
          // eslint-disable-next-line no-console
          console.error(
            `[WatchBot] post-logon expiry scan failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
      const notifies = notifyPoller;
      if (notifies !== undefined) {
        notifies.pollOnce().catch((error: unknown) =>
          // eslint-disable-next-line no-console
          console.error(
            `[WatchBot] post-logon notify poll failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
      }
    },
    // WB-8 official opt-out: unfriend/block observed on the live event.
    // Removals that happened while offline are caught by the reconcile
    // pass instead (same composite, no duplicated logic).
    // handleFriendRemoved never rejects by contract (all failures resolve
    // to { deactivated: false }); the .catch below is defensive-only, kept
    // because dropping it would leave a floating promise.
    onFriendRemoved: (steamId: string) => {
      handleFriendRemoved(
        steamId,
        { removeWatchAndAccount },
        logger,
      ).catch(
        (error: unknown) =>
          logger.error(
            `[WatchBot] friend-remove handling failed: steamId=${steamId}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
      );
    },
  });

  const startedAt = Date.now();
  const heartbeat = startHeartbeat({
    filePath: config.heartbeatPath,
    intervalMs: config.heartbeatIntervalMs,
    startedAt,
    getStatus: () => ({
      connected: bot.isConnected(),
      steamId: bot.getSteamId(),
    }),
  });
  // Immediate first beat so the healthcheck is meaningful from second one
  // (otherwise a fresh process looks stale for a whole interval).
  // Wrap in try/catch: disk full/permission on boot must not crash before
  // bot.start() — the interval beat() already swallows errors.
  try {
    heartbeat.beat();
  } catch (error) {
    console.error(
      `[WatchBot] initial heartbeat write failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  // Stale-claim recovery driver: without this interval, rows orphaned in
  // 'claimed' (crashed worker, failed bookkeeping) would sit forever —
  // every comment promising "~30min recovery" refers to this timer.
  const staleSweeper = startStaleClaimSweeper({
    dal: { resetStaleClaims },
    sweepIntervalMs: config.staleSweepIntervalMs,
    staleWindowMinutes: config.staleClaimWindowMinutes,
  });
  sweepStaleClaimsOnce({
    dal: { resetStaleClaims },
    staleWindowMinutes: config.staleClaimWindowMinutes,
  }).catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial stale sweep failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  invitePoller = startInvitePoller({
    client,
    dal: {
      claimNextQueuedEvents,
      markEventSent,
      markEventDropped,
      recordEventAttempt,
      countInvitesSentSince,
    },
    pollIntervalMs: config.invitePollIntervalMs,
    batchLimit: config.inviteBatchLimit,
    dailyLimit: config.inviteDailyLimit,
    maxAttempts: config.inviteMaxAttempts,
    sendTimeoutMs: config.inviteSendTimeoutMs,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  // Explicit first pass (the poller itself only schedules the interval, so
  // startup ordering stays visible here). A failure rejects into the log,
  // never into an unhandled rejection.
  invitePoller.pollOnce().catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial invite poll failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  // WB-13 notify consumer: same lifecycle as the invite poller (single
  // registration at startup — reconnects only trigger pollOnce, never a
  // second driver — and stopped on shutdown below). The chat surface is
  // the same structural sendFriendMessage the welcome flow casts to.
  notifyPoller = startNotifyPoller({
    chat: client.chat as unknown as NotifyChatClient,
    dal: {
      claimNextQueuedEvents,
      markEventSent,
      markEventDropped,
      recordEventAttempt,
      getWatchedProfile,
    },
    pollIntervalMs: config.notifyPollIntervalMs,
    batchLimit: config.notifyBatchLimit,
    maxAttempts: config.notifyMaxAttempts,
    sendTimeoutMs: config.notifySendTimeoutMs,
    siteUrl: config.siteUrl,
    ttlDays: config.notifyTtlDays,
    isConnected: () => bot.isConnected(),
  });
  notifyPoller.pollOnce().catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial notify poll failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  // Post-click welcome consumer (click-to-activate flow): the confirm
  // route enqueues exactly when it activates, so this lane only ever
  // carries active watches — the recipient gate is a backstop, not the
  // policy. Same lifecycle as invite/notify above.
  welcomePoller = startWelcomePoller({
    chat: client.chat as unknown as WelcomeChatClient,
    dal: {
      claimNextQueuedEvents,
      markEventSent,
      markEventDropped,
      recordEventAttempt,
      getWatchedProfile,
    },
    pollIntervalMs: config.welcomePollIntervalMs,
    batchLimit: config.welcomeBatchLimit,
    maxAttempts: config.welcomeMaxAttempts,
    sendTimeoutMs: config.welcomeSendTimeoutMs,
    isConnected: () => bot.isConnected(),
  });
  welcomePoller.pollOnce().catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial welcome poll failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  // Confirm-link resend consumer (user-awaited lane: someone pressed
  // "generate a new link", so drain fast like invite/notify, not hourly).
  resendPoller = startConfirmResendPoller({
    chat: client.chat as unknown as NotifyChatClient,
    dal: {
      claimNextQueuedEvents,
      markEventSent,
      markEventDropped,
      recordEventAttempt,
      getWatchedProfile,
      getAccount,
      issueConfirmToken,
    },
    pollIntervalMs: config.resendPollIntervalMs,
    batchLimit: config.resendBatchLimit,
    maxAttempts: config.resendMaxAttempts,
    sendTimeoutMs: config.resendSendTimeoutMs,
    siteUrl: config.siteUrl,
    confirmTokenTtlMs: config.confirmTokenTtlMs,
    resendMinIntervalMs: config.resendMinIntervalMs,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  resendPoller.pollOnce().catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial resend poll failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  // Confirm-link expiry scanner (hourly class): single "generate a new
  // one" notice per dead generation. Catches up after downtime on boot
  // via the explicit first pass below (a bot offline past a token expiry
  // still notifies on return).
  expiryPoller = startConfirmExpiryPoller({
    chat: client.chat as unknown as NotifyChatClient,
    dal: {
      listExpiredUnnoticedConfirms,
      getAccount,
      markExpireNoticed,
    },
    pollIntervalMs: config.expiryScanIntervalMs,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  expiryPoller.pollOnce().catch((error: unknown) =>
    // eslint-disable-next-line no-console
    console.error(
      `[WatchBot] initial expiry scan failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    ),
  );

  // Periodic full reconcile (backstop for missed snapshots AND for
  // click-activations that landed while the DB blipped: the confirm
  // route's activate is best-effort, this converges the rest within one
  // interval). Snapshot events alone only fire on (re)logon and accepts,
  // which can be days apart on a stable connection. Gated on connection
  // (offline snapshots would be stale); unref'd like every timer here.
  const reconcileTimer = setInterval(() => {
    if (!bot.isConnected()) return;
    convergeFriends({ ...client.myFriends });
  }, config.reconcileIntervalMs);
  if (typeof reconcileTimer.unref === 'function') {
    reconcileTimer.unref();
  }

  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[WatchBot] received ${signal}, shutting down...`);
    heartbeat.stop();
    staleSweeper.stop();
    clearInterval(reconcileTimer);
    invitePoller?.stop();
    notifyPoller?.stop();
    welcomePoller?.stop();
    resendPoller?.stop();
    expiryPoller?.stop();
    bot.stop();
    // Let logOff flush, then exit. The delay is ref'd on purpose: prompt
    // shutdown still waits out this beat instead of racing process exit
    // against the socket write. Half a second is noise against any
    // supervisor SIGKILL grace period.
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  bot.start();
  // eslint-disable-next-line no-console
  console.log('[WatchBot] starting (logging on to Steam)...');
};

main();
