/**
 * Watch identity (WB-10) — the minimal "me" for the Watch Bot frontend.
 *
 * After POST /api/watch/request succeeds, the frontend stores the watched
 * SteamID64 here; the status-polling hook reads it back to know which
 * profile is being followed. This is explicitly NOT a login or session:
 * no password, token, cookie, or secret is ever stored — just the public
 * SteamID64 the user asked to watch.
 *
 * Every access is SSR-safe (typeof window guard) and private-mode-safe
 * (try/catch around localStorage, which throws in some configurations).
 */

import { isSteamId64 } from '@/lib/steamId';

export const WATCH_IDENTITY_KEY = 'steamreveal:watch:me';

/** SteamID64 shape check shared by the setter (fail fast) and polling. */
export const isValidWatchIdentity = (value: unknown): value is string =>
  isSteamId64(value);

/** The watched SteamID64, or null when absent/invalid/unavailable. */
export const getWatchIdentity = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(WATCH_IDENTITY_KEY);
    return isValidWatchIdentity(raw) ? raw : null;
  } catch {
    return null;
  }
};

/**
 * Stores the watched SteamID64. Returns false (storing nothing) for
 * invalid ids and when storage is unavailable — callers treat false as
 * "identity not persisted", never as an exception.
 */
export const setWatchIdentity = (steamId: string): boolean => {
  if (!isValidWatchIdentity(steamId)) return false;
  if (typeof window === 'undefined') return false;
  try {
    window.localStorage.setItem(WATCH_IDENTITY_KEY, steamId);
    return true;
  } catch {
    return false;
  }
};

/** Removes the stored identity (opt-out on this browser). Never throws. */
export const clearWatchIdentity = (): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(WATCH_IDENTITY_KEY);
  } catch {
    // Nothing was stored (or storage is hostile) — nothing to clear.
  }
};
