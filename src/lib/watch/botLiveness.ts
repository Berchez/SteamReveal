import { getBotHeartbeat } from '@/lib/analytics/db';

/**
 * Bot liveness for the site's sign-in gate (login-first model): the bot
 * process mirrors a heartbeat into Turso every BOT_HEARTBEAT_INTERVAL_MS
 * (see db.ts recordBotHeartbeat / migrations/011). This module decides
 * "can a login even get through right now?" and the navbar hides the
 * sign-in button when the answer is no — so a user never burns a Steam
 * login round-trip only to be told "can't complete, try later".
 *
 * TWO offline causes, BOTH demonstrable (never assumed):
 * 1. STALE BEAT — no fresh write for BOT_ONLINE_MAX_AGE_MS (4 min) means
 *    the bot PROCESS is down (crash, deploy, host). Total detection lag
 *    ≈ 4min (threshold) + up to 1min (heartbeat interval) + up to 1min
 *    (memo) — a few minutes is fine for this decision: no one is
 *    mid-login during a deploy, and the button returning is itself the
 *    "bot is back" signal.
 * 2. SUSTAINED DISCONNECT — the beat is fresh but `connected=0` has held
 *    since `disconnected_since` for BOT_DISCONNECTED_MAX_AGE_MS (5 min):
 *    the process is alive but the Steam session is dead (banned/flagged
 *    account, pending Steam Guard approval, long Steam outage — the
 *    runbook §7 class). A fresh-beat-only gate can never catch this: the
 *    process keeps beating, yet it cannot accept friend requests, so a
 *    new user's login would strand in the waiting room. 5 min sits far
 *    above the reconnect backoff cap (60s default, see
 *    src/bot-steam/config.ts), so transient disconnects / fast
 *    reconnects never trip it.
 *
 * Thresholds are COUPLED to the bot's cadence (src/bot-steam/config.ts):
 * BOT_HEARTBEAT_INTERVAL_MS must stay well below both windows or the
 * site starts seeing a healthy bot as flapping/offline.
 *
 * - BOT_LIVENESS_MEMO_MS (1 min): the decision changes slowly, so cache
 *   it per instance (same rationale as the identity memo in
 *   getSteamIdentity), SINGLE-FLIGHT the refresh (same pattern as
 *   watchStatusPrefetch) so concurrent SSR requests at TTL expiry share
 *   one read instead of herding, and keep the logged-out SSR hot path at
 *   ~1 read/min/instance instead of one Turso round-trip per page view.
 *
 * FAIL-OPEN by contract: any read failure, a missing row (bot not yet
 * deployed), or an unparseable timestamp (either clock) resolves to
 * ONLINE — the button must never disappear because of an unrelated
 * DB/transport blip. Only a demonstrably stale beat or a demonstrably
 * sustained disconnect hides it.
 *
 * ACCEPTED TRADE-OFF (audience-blind gate — sign-off in
 * WATCH_PROD_READINESS.md §4): while the bot is offline the button hides
 * for EVERYONE, including users already friends with the bot (their
 * login would actually work: the friendship check runs against Steam's
 * Web API from the SITE, not from the bot process, and their welcome is
 * queued, not lost). The site cannot know pre-OpenID who is a friend, so
 * the gate cannot be audience-aware; a returning friend retries later,
 * while a fresh user saved from a doomed waiting room is the audience
 * this gate exists for.
 */

export const BOT_ONLINE_MAX_AGE_MS = 4 * 60 * 1000;
export const BOT_DISCONNECTED_MAX_AGE_MS = 5 * 60 * 1000;
export const BOT_LIVENESS_MEMO_MS = 60 * 1000;

let memo: { at: number; value: boolean } | null = null;
let inFlight: Promise<boolean> | null = null;

/** Test seam (mirrors clearSteamIdentityCache): forces the next read. */
export const clearBotLivenessMemo = (): void => {
  memo = null;
};

export const isBotOnline = async (): Promise<boolean> => {
  const now = Date.now();
  if (memo !== null && now - memo.at < BOT_LIVENESS_MEMO_MS) {
    return memo.value;
  }
  // Single-flight (watchStatusPrefetch pattern): the first caller past the
  // TTL owns the read; concurrent callers join it instead of piling a
  // redundant Turso round-trip per request onto the same instant.
  if (inFlight !== null) {
    return inFlight;
  }

  const read = (async () => {
    let online = true;
    try {
      const beat = await getBotHeartbeat();
      if (beat !== null) {
        const beatAt = Date.parse(beat.beatAt);
        if (!Number.isFinite(beatAt)) {
          // Corrupt beat clock = unknown, not offline (fail-open).
          online = true;
        } else if (now - beatAt >= BOT_ONLINE_MAX_AGE_MS) {
          // Cause 1: process down (no fresh beats).
          online = false;
        } else if (beat.connected) {
          online = true;
        } else if (beat.disconnectedSince === null) {
          // connected=0 but no window clock (legacy row from a bot version
          // that predates the column): duration unknown — never hide on
          // missing evidence.
          online = true;
        } else {
          // Cause 2: session down; for how long?
          const since = Date.parse(beat.disconnectedSince);
          online =
            !Number.isFinite(since) ||
            now - since < BOT_DISCONNECTED_MAX_AGE_MS;
        }
      }
    } catch {
      // DAL/transport failure: fail-open — the button must never hide on
      // an unrelated blip.
      online = true;
    }
    memo = { at: now, value: online };
    return online;
  })();

  inFlight = read.finally(() => {
    inFlight = null;
  });
  return inFlight;
};
