/**
 * Watch inbox read state (WB-14) — local "seen" watermark per watched
 * profile, so the bell can count unread notifications without any schema
 * change (no `read_at` column).
 *
 * The watermark is the max SEARCH timestamp (searched_at ISO) observed,
 * NOT the max event id. Search ids embed wall-clock plus randomness, so
 * they are not strictly ordered; searched_at ordering matches the inbox
 * list ordering (searched_at DESC), keeping cursor and display consistent
 * by construction.
 *
 * Why local state is sufficient (explicit decision, per ticket): the bell
 * answers "what arrived since I last looked on THIS browser". Cross-device
 * sync would need server-side read state, which is out of scope — a second
 * device simply counts from its own first open.
 *
 * Same safety contract as the old watchIdentity module (retired with the
 * Steam OpenID migration): SSR-safe (typeof window guard),
 * private-mode-safe (try/catch), never throws, invalid ids are no-ops.
 *
 * STORAGE KEY NOTE: the key keeps its historic `:seen:` name and pre-split
 * values stay valid cursors — both eras store full ISO UTC timestamps
 * compared lexicographically, and delivery times always postdate their
 * search times, so a stale sent_at watermark can only over-mark (never
 * under-mark) on upgrade, self-healing on the next open.
 */

import { isSteamId64 } from '@/lib/steamId';

export const WATCH_SEEN_KEY_PREFIX = 'steamreveal:watch:seen:';

const seenKey = (steamId: string): string | null =>
  isSteamId64(steamId) ? `${WATCH_SEEN_KEY_PREFIX}${steamId}` : null;

/**
 * Strict ISO-UTC check shared by the inbox parser and the watermark: full
 * shape as written by `new Date().toISOString()` (a bare Date.parse is
 * too lax — it accepts '12345' as year 12345). One ruler for both, so a
 * row can never render without being watermarkable (which would pin its
 * badge unread forever).
 */
export const isValidWatchTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Max searched_at opened so far, or null when never opened. */
export const getLastSeenSearchedAt = (steamId: string): string | null => {
  const key = seenKey(steamId);
  if (key === null || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return isValidWatchTimestamp(raw) ? raw : null;
  } catch {
    return null;
  }
};

/**
 * Records the watermark, or CLEARS it when searchedAt is null. Clearing
 * (not just ignoring) is load-bearing: callers pass null precisely when
 * the stored value proved corrupt — leaving it would retry the same bad
 * cursor forever. Ignores invalid inputs; never throws.
 */
export const setLastSeenSearchedAt = (
  steamId: string,
  searchedAt: string | null,
): void => {
  const key = seenKey(steamId);
  if (key === null) return;
  if (typeof window === 'undefined') return;
  try {
    if (searchedAt === null) {
      window.localStorage.removeItem(key);
      return;
    }
    if (!isValidWatchTimestamp(searchedAt)) return;
    window.localStorage.setItem(key, searchedAt);
  } catch {
    // Hostile storage (private mode): unread count just recomputes next
    // visit — degraded, never broken.
  }
};

/**
 * Latest finite-date searchedAt in a row set, or null when none qualifies.
 * The inbox watermarks exactly this after opening: newest-first display
 * means the first row USUALLY holds it, but the max (not position 0)
 * stays correct even if the API ever returns another order.
 */
export const latestSearchedAt = (
  rows: Array<{ searchedAt: string }>,
): string | null => {
  let latest: string | null = null;
  rows.forEach((row) => {
    if (!isValidWatchTimestamp(row.searchedAt)) return;
    if (latest === null || row.searchedAt > latest) latest = row.searchedAt;
  });
  return latest;
};
