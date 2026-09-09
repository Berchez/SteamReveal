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
  deactivateWatch,
  listWatchedProfiles,
  markEventSent,
  recordEventAttempt,
  resetStaleClaims,
} from '../lib/analytics/db';
import { loadBotConfig } from './config';
import { WatchBot } from './bot';
import { reconcileFriendsList } from './reconcile';
import { startHeartbeat } from './heartbeat';
import { startInvitePoller } from './invitePoller';
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

  // Declared before the bot: onConnected (below) fires the first invite
  // pass, so it needs the handle — assigned further down during the same
  // synchronous setup, long before any logon can complete.
  let invitePoller: ReturnType<typeof startInvitePoller> | undefined;

  const bot = new WatchBot({
    client,
    accountName: config.accountName,
    password: config.password,
    sharedSecret: config.sharedSecret,
    reconnectBaseMs: config.reconnectBaseMs,
    reconnectMaxMs: config.reconnectMaxMs,
    // reconcile() is async but the snapshot event is sync: a rejection
    // here must never become an unhandled rejection that kills the
    // process (reconcile already isolates per-row errors; this is the
    // last-resort guard for listWatchedProfiles-level failures).
    onFriendsSnapshot: (friendsById) => {
      reconcileFriendsList(
        friendsById,
        SteamUser.EFriendRelationship.Friend,
        { listWatchedProfiles, activateWatch, deactivateWatch },
      ).catch((error) => {
        // eslint-disable-next-line no-console
        console.error(
          `[WatchBot] reconcile failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
    },
    // Prompt first invite pass on every (re)logon instead of waiting for
    // the next interval tick — queued invites drain right after reconnects.
    // The poller itself re-checks connection, so a stray call is a safe
    // no-op, never a wasted invite attempt.
    onConnected: () => {
      const poller = invitePoller;
      if (poller === undefined) return;
      poller.pollOnce().catch((error: unknown) =>
        // eslint-disable-next-line no-console
        console.error(
          `[WatchBot] post-logon invite poll failed: ${
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
  heartbeat.beat();

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
    dal: { claimNextQueuedEvents, markEventSent, recordEventAttempt },
    pollIntervalMs: config.invitePollIntervalMs,
    batchLimit: config.inviteBatchLimit,
    maxAttempts: config.inviteMaxAttempts,
    sendTimeoutMs: config.inviteSendTimeoutMs,
    isConnected: () => bot.isConnected(),
  });
  // Explicit first pass (the poller itself only schedules the interval, so
  // startup ordering stays visible here). A failure rejects into the log,
  // never into an unhandled rejection.
  invitePoller
    .pollOnce()
    .catch((error: unknown) =>
      // eslint-disable-next-line no-console
      console.error(
        `[WatchBot] initial invite poll failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );

  let shuttingDown = false;
  const shutdown = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // eslint-disable-next-line no-console
    console.log(`[WatchBot] received ${signal}, shutting down...`);
    heartbeat.stop();
    staleSweeper.stop();
    invitePoller?.stop();
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
