/**
 * Per-viewer throttle for the history-reconnect Steam read
 * (GET /api/history/reconnect).
 *
 * Each poll tick costs one GetFriendList read against the shared Steam
 * API quota, and the modal polls on pendingPolicy cadence (10s, then
 * 30s) PER OPEN TAB — five tabs of one waiter already quintuple the
 * cost. The footprint fast path (hasAccountFootprint) stays unthrottled:
 * it is one indexed PK read and completion must be instant. Only the
 * Steam read is gated: at most one per viewer per gap, late tabs just
 * answer `{done:false}` and retry next tick (worst case adds one poll
 * interval of resume latency — invisible against a 10s+ cadence).
 *
 * Module-scoped Map = per-warm-instance, same accepted caveat as
 * createRateLimiter (a multi-instance flood still passes). Opportunistic
 * purge past MAX_TRACKED_VIEWERS keeps memory bounded: entries older
 * than the gap are dropped first, full clear only if still over (a
 * pathological burst degrades to re-reading, never to unbounded
 * growth). Leaf module, zero deps — safe for routes AND unit tests.
 */

export const RECONNECT_STEAM_READ_MIN_GAP_MS = 8_000;

const MAX_TRACKED_VIEWERS = 500;

const lastSteamReadByViewer = new Map<string, number>();

export const shouldThrottleReconnectRead = (
  steamId: string,
  now: number = Date.now(),
): boolean => {
  // No stamp yet (or reset): always allow — the `?? 0` sentinel would
  // wrongly throttle small `now` values in tests.
  const last = lastSteamReadByViewer.get(steamId);
  if (last !== undefined && now - last < RECONNECT_STEAM_READ_MIN_GAP_MS) {
    return true;
  }
  if (lastSteamReadByViewer.size >= MAX_TRACKED_VIEWERS) {
    const cutoff = now - RECONNECT_STEAM_READ_MIN_GAP_MS;
    // forEach (not for..of: tsconfig target lacks downlevelIteration).
    // Deleting during Map.forEach is safe per spec.
    lastSteamReadByViewer.forEach((readAt, viewer) => {
      if (readAt <= cutoff) {
        lastSteamReadByViewer.delete(viewer);
      }
    });
    if (lastSteamReadByViewer.size >= MAX_TRACKED_VIEWERS) {
      lastSteamReadByViewer.clear();
    }
  }
  lastSteamReadByViewer.set(steamId, now);
  return false;
};

/** Test-only seam: drop the per-viewer timestamps between tests. */
export const resetReconnectThrottleForTests = (): void => {
  lastSteamReadByViewer.clear();
};
