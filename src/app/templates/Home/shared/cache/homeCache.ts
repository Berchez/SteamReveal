import { CheaterDataType } from '@/@types/cheaterDataType';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';

type CachedSearch = {
  targetInfoJson: targetInfoJsonType;
  closeFriendsJson: closeFriendsDataIWant[];
  possibleLocationJson: locationDataIWant[];
  cheaterData?: CheaterDataType;
  searchId?: string | null;
};

// Simple cap so a long session doesn't grow this Map forever. Not a real
// LRU — just evicts the oldest inserted entry (Map preserves insertion
// order) once we're over the limit. Good enough for a client-side,
// per-tab cache.
const MAX_CACHE_ENTRIES = 65;

// Canonical cache, keyed by the resolved SteamID64. This is the id every
// code path (initial search, later cheater-probability update) can
// reliably derive — unlike the raw search-box value, which can be a
// vanity URL, a profile link, a SteamID3, etc.
const cacheById = new Map<string, CachedSearch>();

// Maps whatever the user actually typed to the SteamID64 it resolved to,
// so repeating the exact same search short-circuits straight to the
// canonical entry above without a second network round trip.
const aliasToId = new Map<string, string>();

const evictOldestIfNeeded = () => {
  if (cacheById.size <= MAX_CACHE_ENTRIES) {
    return;
  }
  const oldestKey = cacheById.keys().next().value;
  if (oldestKey === undefined) {
    return;
  }
  cacheById.delete(oldestKey);

  // Also drop any aliases pointing at the entry we just evicted, otherwise
  // aliasToId grows forever even as cacheById stays capped.
  aliasToId.forEach((id, alias) => {
    if (id === oldestKey) {
      aliasToId.delete(alias);
    }
  });
};

/**
 * Looks up a cached search by whatever the user typed (vanity URL, profile
 * link, raw SteamID...). Resolves through the alias map first, falling
 * back to treating the value itself as an id (covers the case where the
 * user literally typed the SteamID64).
 */
export const getCachedSearch = (searchedValue: string) => {
  const id = aliasToId.get(searchedValue) ?? searchedValue;
  return cacheById.get(id);
};

/**
 * Stores a finished search. `searchedValue` is what the user typed (used
 * to fast-path a repeat of the exact same search); `steamId` is the
 * resolved SteamID64 (the canonical key, used everywhere else).
 */
export const setCachedSearch = (
  searchedValue: string,
  steamId: string,
  data: CachedSearch,
) => {
  cacheById.set(steamId, data);
  aliasToId.set(searchedValue, steamId);
  evictOldestIfNeeded();
};

/** Patches an already-cached entry by its resolved SteamID64. No-op if it isn't cached (e.g. was evicted). */
export const updateCachedSearchById = (
  steamId: string,
  patch: Partial<CachedSearch>,
) => {
  const existing = cacheById.get(steamId);
  if (!existing) {
    return;
  }
  cacheById.set(steamId, { ...existing, ...patch });
};
