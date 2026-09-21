/**
 * Watch Bot entrypoint — `pnpm run start:bot`.
 *
 * Long-lived process (same model as src/proxy-local/server.ts, NOT Vercel
 * serverless): keeps one Steam session up, reconciles the friendsList
 * snapshot against watched_profiles on every (re)logon, and writes a
 * heartbeat file for scripts/healthcheck-bot.ts.
 *
 * Nothing in this file is imported by tests or by Next.js — it only runs
 * when executed directly. That convention is load-bearing, not stylistic:
 * importing this module boots the bot (main() at the bottom) AND installs
 * global crash handlers (installCrashHandlers below) — a future test (or
 * refactor) importing it would log into Steam inside the test worker and
 * accumulate process.on listeners across files (up to exit(1) killing an
 * unrelated suite). Keep it that way; if this ever needs importing, guard
 * the side effects behind require.main first.
 */
import SteamUser from 'steam-user';

import { loadEnv } from '../lib/env';
import { installCrashHandlers, writeOpsLog } from '../lib/opsLog';
import {
  activateWatch,
  claimNextQueuedEvents,
  clearConfirmToken,
  countInvitesSentSince,
  getAccount,
  getWatchedProfile,
  issueConfirmToken,
  listExpiredUnnoticedConfirms,
  listWatchedProfiles,
  markEventDropped,
  markEventSent,
  markExpireNoticed,
  recordBotHeartbeat,
  recordEventAttempt,
  removeWatchAndAccount,
  resetStaleClaims,
} from '../lib/analytics/db';
import { isLocalLinkHostname, loadBotConfig } from './config';
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

// Last-resort crash trace (bug-capture net — shared helper, same contract
// as the proxy): stderr + durable file, then non-zero exit. Deliberately
// NOT added to the Next.js dev server (hot-reload semantics).
installCrashHandlers('bot');

const main = (): void => {
  let config;
  try {
    config = loadBotConfig();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error(`[WatchBot] invalid configuration: ${detail}`);
    // Runs before the logger adapter exists — write the file line directly
    // (console line above is unchanged).
    writeOpsLog('bot', 'error', `invalid configuration: ${detail}`);
    process.exit(1);
  }

  // Localhost trap (real incident: a dev .env driving the production
  // queue sent users localhost notify/confirm links — valid URL, so boot
  // validation passes and nothing fails loudly). Non-fatal by design
  // (local dev legitimately uses localhost); just impossible to miss.
  if (isLocalLinkHostname(new URL(config.siteUrl).hostname)) {
    // eslint-disable-next-line no-console
    console.warn(
      '[WatchBot] WARNING: WATCH_SITE_URL points at this machine/network ' +
        `(${config.siteUrl}). Every notify/confirm link the bot sends ` +
        'will point here too — fine for local-only queues, BROKEN for ' +
        'users if this bot serves the production queue (shared DB). ' +
        'Set WATCH_SITE_URL to the public site URL and restart.',
    );
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
  // in exactly one place. Console behavior is unchanged; every line is
  // ALSO appended to .data/logs/ (bug-capture net — writeOpsLog never
  // throws, so a failed write degrades to the console line alone).
  const logger: WatchBotLogger = {
    info: (message: string): void => {
      // eslint-disable-next-line no-console
      console.log(message);
      writeOpsLog('bot', 'info', message);
    },
    error: (message: string): void => {
      // eslint-disable-next-line no-console
      console.error(message);
      writeOpsLog('bot', 'error', message);
    },
  };

  // Single-shape poll failure logging: every pollOnce .catch below shares
  // this form, so labels live in one place and cannot drift between lanes.
  // Console text is byte-identical to the inlined version it replaces.
  const logPollError =
    (label: string) =>
    (error: unknown): void => {
      logger.error(
        `[WatchBot] ${label}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    };

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
    ).catch(logPollError('reconcile failed'));
  };

  // sysexits EX_CONFIG: the process refuses to run with a wrong identity.
  // Supervisors must treat this code as "fix the env, do NOT rapid-restart"
  // (RestartPreventExitStatus=78 / pm2 --stop-exit-codes / capped Docker
  // retries) — see the runbook restart policy.
  const FATAL_CONFIG_EXIT_CODE = 78;

  const bot = new WatchBot({
    client,
    accountName: config.accountName,
    password: config.password,
    sharedSecret: config.sharedSecret,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    // Sink-side Sybil bound (single-state auto-accept): without these the
    // bot accepts every inbound request unbounded — a throwaway-account
    // burst fills the Steam friends list and blocks all new onboarding.
    autoAcceptFriendCap: config.autoAcceptFriendCap,
    autoAcceptDailyLimit: config.autoAcceptDailyLimit,
    // Identity self-check: the site gates logins on friendship with THIS
    // id, so a drifted env (or a BOT_DATA_DIR reused from another account)
    // would silently deny every login — the bot FAILS FAST on mismatch
    // (stop + onFatal below), never logging-and-carrying-on.
    expectedBotSteamId: config.botSteamId,
    // Fatal exit for the identity mismatch (WatchBot stops itself first):
    // a wrong-account bot is not "degraded", it is DESTRUCTIVE — its next
    // friendsList snapshot would make reconcile read every active watch as
    // an opt-out and delete the base. Exit 78 (sysexits EX_CONFIG:
    // configuration error) instead of logging forever: the supervisor
    // restart is the loud signal (crash-loop until the envs agree on both
    // hosts), the heartbeat goes stale (healthcheck:bot alerts, the site's
    // liveness gate hides sign-in), and no destructive pass ever runs.
    // Exit code matters here, not just non-zero: 78 tells a configured
    // supervisor NOT to rapid-restart (RestartPreventExitStatus=78), since
    // every restart burns a Steam logon and fast logon churn invites
    // Steam-side throttling that outlasts the env fix — see the runbook
    // restart policy. The 500ms delay mirrors shutdown's logOff flush.
    onFatal: (reason: string) => {
      logger.error(`[WatchBot] FATAL: ${reason} — exiting 78 (supervisor must not rapid-restart: see runbook restart policy)`);
      setTimeout(() => process.exit(FATAL_CONFIG_EXIT_CODE), 500);
    },
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
        invites.pollOnce().catch(logPollError('post-logon invite poll failed'));
      }
      const welcomes = welcomePoller;
      if (welcomes !== undefined) {
        welcomes.pollOnce().catch(logPollError('post-logon welcome poll failed'));
      }
      const resends = resendPoller;
      if (resends !== undefined) {
        resends.pollOnce().catch(logPollError('post-logon resend poll failed'));
      }
      const expiries = expiryPoller;
      if (expiries !== undefined) {
        expiries.pollOnce().catch(logPollError('post-logon expiry scan failed'));
      }
      const notifies = notifyPoller;
      if (notifies !== undefined) {
        notifies.pollOnce().catch(logPollError('post-logon notify poll failed'));
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
    logPollError('initial heartbeat write failed')(error);
  }

  // Turso heartbeat mirror (bot-liveness for the site): the file beat above
  // is for healthcheck:bot, but the Vercel navbar cannot read that file
  // across hosts — so the same facts are upserted into bot_heartbeat on
  // the same cadence. Best-effort by contract: a DB blip must never crash
  // the bot (it only degrades to "site assumes online" until the next
  // successful write). `connected` + session id are ops-visible; the site
  // gate reads beat age + the sustained-disconnect window (db.ts
  // recordBotHeartbeat maintains disconnected_since in the upsert SQL).
  let tursoBeatInFlight = false;
  const tursoHeartbeat = (): void => {
    // Overlap guard, same pattern as every poller lane below: a slow Turso
    // write (network backoff) must not pile concurrent upserts onto one
    // tick — the upsert is idempotent, so a skipped tick costs nothing
    // (the next interval writes fresh facts).
    if (tursoBeatInFlight) return;
    tursoBeatInFlight = true;
    recordBotHeartbeat(bot.isConnected(), bot.getSteamId())
      .catch((error: unknown) =>
        logPollError('turso heartbeat write failed')(error),
      )
      .finally(() => {
        tursoBeatInFlight = false;
      });
  };
  tursoHeartbeat();
  const tursoHeartbeatTimer = setInterval(tursoHeartbeat, config.heartbeatIntervalMs);
  if (typeof tursoHeartbeatTimer.unref === 'function') {
    tursoHeartbeatTimer.unref();
  }

  // Stale-claim recovery driver: without this interval, rows orphaned in
  // 'claimed' (crashed worker, failed bookkeeping) would sit forever —
  // every comment promising "~30min recovery" refers to this timer.
  const staleSweeper = startStaleClaimSweeper({
    dal: { resetStaleClaims },
    logger,
    sweepIntervalMs: config.staleSweepIntervalMs,
    staleWindowMinutes: config.staleClaimWindowMinutes,
  });
  sweepStaleClaimsOnce({
    dal: { resetStaleClaims },
    logger,
    staleWindowMinutes: config.staleClaimWindowMinutes,
  }).catch(logPollError('initial stale sweep failed'));

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
    logger,
    maxAttempts: config.inviteMaxAttempts,
    sendTimeoutMs: config.inviteSendTimeoutMs,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  // Explicit first pass (the poller itself only schedules the interval, so
  // startup ordering stays visible here). A failure rejects into the log,
  // never into an unhandled rejection.
  invitePoller.pollOnce().catch(logPollError('initial invite poll failed'));

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
    logger,
    isConnected: () => bot.isConnected(),
  });
  notifyPoller.pollOnce().catch(logPollError('initial notify poll failed'));

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
    logger,
    maxAttempts: config.welcomeMaxAttempts,
    sendTimeoutMs: config.welcomeSendTimeoutMs,
    isConnected: () => bot.isConnected(),
  });
  welcomePoller.pollOnce().catch(logPollError('initial welcome poll failed'));

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
      clearConfirmToken,
    },
    pollIntervalMs: config.resendPollIntervalMs,
    batchLimit: config.resendBatchLimit,
    maxAttempts: config.resendMaxAttempts,
    sendTimeoutMs: config.resendSendTimeoutMs,
    siteUrl: config.siteUrl,
    confirmTokenTtlMs: config.confirmTokenTtlMs,
    logger,
    resendMinIntervalMs: config.resendMinIntervalMs,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  resendPoller.pollOnce().catch(logPollError('initial resend poll failed'));

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
    logger,
    isConnected: () => bot.isConnected(),
    isFriend,
  });
  expiryPoller.pollOnce().catch(logPollError('initial expiry scan failed'));

  // Periodic full reconcile (backstop for missed snapshots AND for
  // click-activations that landed while the DB blipped: the confirm
  // route's activate is best-effort, this converges the rest within one
  // interval). Snapshot events alone only fire on (re)logon and accepts,
  // which can be days apart on a stable connection. Gated on connection
  // (offline snapshots would be stale); unref'd like every timer here.
  const reconcileTimer = setInterval(() => {
    if (!bot.isConnected()) return;
    convergeFriends({ ...client.myFriends });
    // Deferred-accept retry (same interval, same gate): inbound requests
    // refused earlier by the auto-accept ceilings (daily budget, friend
    // cap) converge here once the UTC day rolls over or slots free up —
    // without this they would wait for the next reconnect, potentially
    // days on a stable connection. Fire-and-forget (never throws).
    bot.sweepPendingRequests();
  }, config.reconcileIntervalMs);
  if (typeof reconcileTimer.unref === 'function') {
    reconcileTimer.unref();
  }

  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`[WatchBot] received ${signal}, shutting down...`);
    heartbeat.stop();
    clearInterval(tursoHeartbeatTimer);
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
