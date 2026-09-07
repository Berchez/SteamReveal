/**
 * Client-side registry of GamersClub names, keyed by SteamID64.
 *
 * The friend cards resolve each friend's GC name in their own component
 * (useGamersClubName) after the search data lands — by the time
 * recordAnalytics posts, that data simply doesn't exist yet, so the initial
 * analytics payload always carries friends.gcName: null. This store is the
 * shared sink where those per-card resolutions land, so the backfill
 * (friendGcNamesSync) can later flush them to the Turso analytics DB.
 *
 * Deliberately separate from homeCache: gcName is a property of the FRIEND,
 * not of a search, so a name discovered for one target can be reused for any
 * later search that shares that friend — same baseline semantics as the
 * proxy's disk cache (src/proxy-local/utils/gcNameCache.ts). Module-scoped
 * per tab/session; a page reload starts empty again.
 *
 * Only CONFIRMED names are stored. A null result is ambiguous (GamersClub
 * "not found" vs. a failed/rate-limited scrape), so it is never written here
 * — a backfill must never present "saw no GC name" as a fact.
 */
const gcNamesById = new Map<string, string>();

export const setFriendGcName = (steamId: string, name: string): void => {
  if (!steamId || !name) {
    return;
  }
  gcNamesById.set(steamId, name);
};

export const getFriendGcName = (steamId: string): string | undefined =>
  gcNamesById.get(steamId);

/** Snapshot of the whole registry (used by the backfill + tests). */
export const getFriendGcNameRegistry = (): ReadonlyMap<string, string> =>
  new Map(gcNamesById);

/** Test-only: wipe the registry between tests/sessions. */
export const clearFriendGcNames = (): void => {
  gcNamesById.clear();
};
