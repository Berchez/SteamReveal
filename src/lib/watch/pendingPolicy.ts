/**
 * Waiting-room poll contract — the SINGLE source shared by the client
 * cadence (`PendingLoginRoom`) and the server budget (`pending/route.ts`).
 *
 * Why one file: `POLL_INTERVAL` (client) and `RATE_LIMIT_*` (server) only
 * work together by arithmetic (polls/min must fit the per-IP budget with
 * headroom) — kept as adjacent literals they can only drift apart
 * silently when someone retunes the client. Both sides import from here
 * (leaf module, zero deps — safe for the client bundle AND the route),
 * and `pendingPolicy.test.ts` pins the inequality itself.
 *
 * Tiers: full 10s cadence for the first minute (covers bot-accept lag +
 * ordinary user fumbling while the wait is young), then 30s. Detection
 * lag after minute one is acceptable (the user already waited that long),
 * and the relaxed tier cuts an abandoned 30-minute wait from ~180 to ~65
 * GetFriendList reads against the shared Steam quota.
 */

export const PENDING_POLL_FAST_MS = 10_000;
export const PENDING_POLL_FAST_ROUNDS = 6;
export const PENDING_POLL_SLOW_MS = 30_000;

export const PENDING_RATE_LIMIT_WINDOW_MS = 60_000;
export const PENDING_RATE_LIMIT_MAX = 30;

/**
 * Delay before the next poll given how many waits are already scheduled.
 * Pure (trivially testable); the component owns the counter.
 */
export const pendingPollDelay = (scheduledWaits: number): number =>
  scheduledWaits < PENDING_POLL_FAST_ROUNDS
    ? PENDING_POLL_FAST_MS
    : PENDING_POLL_SLOW_MS;
