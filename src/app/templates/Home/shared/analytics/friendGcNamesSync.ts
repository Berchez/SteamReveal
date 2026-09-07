import axios from 'axios';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { FriendGcNameEntry } from '@/lib/analytics/types';
import { getFriendGcNameRegistry } from './friendGcNameStore';
import { getAnalyticsSkipHeaders } from './homeAnalyticsUtils';

/**
 * Best-effort backfill of the friends' GamersClub names into the analytics
 * DB (POST /api/recordAnalyticsFriends).
 *
 * The friend cards resolve GC names after render (per-card, see
 * useGamersClubName), so the initial recordAnalytics payload can't carry
 * them. This module collects what the UI has actually resolved and flushes it
 * later, on a couple of short delays that give the cards' fetches time to run.
 * Pure helpers (collectFriendGcNames / postFriendGcNames / scheduleSyncAttempts)
 * live here so the scheduling logic in useHomeSearch stays thin and testable.
 */

// Two ticks: the first catches fast resolutions (proxy cache hits), the
// second catches slower ones (an actual GamersClub scrape). Deliberately
// short — these must never hold up or interfere with anything on screen.
export const FRIEND_GC_NAME_SYNC_DELAYS_MS = [2500, 6000];

/**
 * Builds the `<steamId, gcName>` list to flush for a given search's friends,
 * intersecting the friend list with what the registry actually knows, and
 * excluding any steamId already sent (`exclude`). Only CONFIRMED names are
 * emitted (the store never holds nulls). Dedupes against repeated friend ids.
 * Pure: the registry can be passed in for tests; defaults to the live store.
 */
export const collectFriendGcNames = (
  closeFriends: closeFriendsDataIWant[] | undefined,
  registry: ReadonlyMap<string, string> = getFriendGcNameRegistry(),
  exclude: ReadonlySet<string> = new Set(),
): FriendGcNameEntry[] => {
  if (!closeFriends?.length) {
    return [];
  }

  const seen = new Set<string>();
  const entries: FriendGcNameEntry[] = [];

  closeFriends.forEach(({ friend }) => {
    const steamId = friend?.steamID;
    if (!steamId || exclude.has(steamId) || seen.has(steamId)) {
      return;
    }
    seen.add(steamId);
    const gcName = registry.get(steamId);
    if (gcName) {
      entries.push({ steamId, gcName });
    }
  });

  return entries;
};

/**
 * Flushes one batch to /api/recordAnalyticsFriends. Best-effort: never
 * throws — any failure (network, 4xx, missing skip secret) resolves to
 * false. Returns true only when the route acknowledged the write.
 */
export const postFriendGcNames = async (
  searchId: string,
  entries: FriendGcNameEntry[],
): Promise<boolean> => {
  if (!searchId || entries.length === 0) {
    return false;
  }

  try {
    const { data } = await axios.post(
      '/api/recordAnalyticsFriends',
      { searchId, gcNames: entries },
      { headers: getAnalyticsSkipHeaders() },
    );
    return data?.ok === true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[Analytics] Failed to backfill friend GC names:', e);
    return false;
  }
};

/**
 * Schedules `attempt` once per delay and returns a cancel function. Guarded
 * for SSR/no-window environments (no-op that never schedules).
 */
export const scheduleSyncAttempts = (
  delaysMs: readonly number[],
  attempt: () => void,
): (() => void) => {
  if (typeof window === 'undefined') {
    return () => {};
  }
  const timers = delaysMs.map((delay) => window.setTimeout(attempt, delay));
  return () => {
    timers.forEach((timer) => window.clearTimeout(timer));
  };
};
