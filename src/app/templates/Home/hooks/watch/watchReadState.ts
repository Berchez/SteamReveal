/**
 * Watch inbox read state (WB-14) — local "seen" watermark per watched
 * profile, so the bell can count unread notifications without any schema
 * change (no `read_at` column).
 *
 * The watermark is the max DELIVERY timestamp (sent_at ISO) observed, NOT
 * the max event id. Ids are creation-ordered; deliveries are not: a
 * requeued event keeps its old id but lands a fresh sent_at, so an
 * id-cursor would silently skip a late-delivered retry that arrived after
 * a newer id was already seen. sent_at ordering matches the inbox list
 * ordering (sent_at DESC), keeping cursor and display consistent by
 * construction.
 *
 * Why local state is sufficient (explicit decision, per ticket): the bell
 * answers "what arrived since I last looked on THIS browser". Cross-device
 * sync would need server-side read state, which is out of scope — a second
 * device simply counts from its own first open.
 *
 * Same safety contract as the old watchIdentity module (retired with the
 * Steam OpenID migration): SSR-safe (typeof window guard),
 * private-mode-safe (try/catch), never throws, invalid ids are no-ops.
 */

import { isSteamId64 } from '@/lib/steamId';

export const WATCH_SEEN_KEY_PREFIX = 'steamreveal:watch:seen:';

const seenKey = (steamId: string): string | null =>
  isSteamId64(steamId) ? `${WATCH_SEEN_KEY_PREFIX}${steamId}` : null;

const isValidSentAt = (value: unknown): value is string =>
  // Full ISO shape as written by `new Date().toISOString()` (a bare
  // Date.parse check is too lax — it accepts '12345' as year 12345).
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) &&
  Number.isFinite(Date.parse(value));

/** Max delivered sent_at opened so far, or null when never opened. */
export const getLastSeenSentAt = (steamId: string): string | null => {
  const key = seenKey(steamId);
  if (key === null || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return isValidSentAt(raw) ? raw : null;
  } catch {
    return null;
  }
};

/** Records the watermark. Ignores invalid inputs; never throws. */
export const setLastSeenSentAt = (steamId: string, sentAt: string): void => {
  const key = seenKey(steamId);
  if (key === null) return;
  if (!isValidSentAt(sentAt)) return;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, sentAt);
  } catch {
    // Hostile storage (private mode): unread count just recomputes next
    // visit — degraded, never broken.
  }
};

/**
 * Latest finite-date sentAt in a row set, or null when none qualifies.
 * The inbox watermarks exactly this after opening: newest-first display
 * means the first row USUALLY holds it, but the max (not position 0)
 * stays correct even if the API ever returns another order.
 */
export const latestSentAt = (
  rows: Array<{ sentAt: string }>,
): string | null => {
  let latest: string | null = null;
  rows.forEach((row) => {
    if (!isValidSentAt(row.sentAt)) return;
    if (latest === null || row.sentAt > latest) latest = row.sentAt;
  });
  return latest;
};
