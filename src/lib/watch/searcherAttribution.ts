/**
 * Viewer identity for "my search history" (recordAnalytics attribution).
 *
 * Lives OUTSIDE the route file on purpose: Next 14 route modules only
 * accept route exports (GET/POST/…, runtime, revalidate, …) — the
 * test-only warn re-arm below would fail `next build` type-checking from
 * inside a route.ts ("not a valid Route export field": green unit CI,
 * red Vercel deploy). Routes import readSearcherSteamId (and
 * hasAccountFootprint for the history empty-state flag); tests import
 * the reset seam; nothing else lives here.
 *
 * Server-only (imports the DAL). The cookie store arrives as a parameter
 * so this module never touches next/headers itself.
 */

import type { CookieStore } from 'iron-session';

import { getAccount } from '../analytics/db';
import logRouteError from '../logRouteError';
import { sanitizeError } from '../sanitizeError';

import { getSessionSteamId } from './session';

let searcherSessionWarned = false;

const warnSearcherAttributionOnce = (message: string): void => {
  if (searcherSessionWarned) return;
  searcherSessionWarned = true;
  logRouteError('recordAnalytics', message);
};

/** Test-only seam: re-arm the warn-once above between tests. */
export const resetSearcherSessionWarnForTests = (): void => {
  searcherSessionWarned = false;
};

/**
 * Single "does this steamId still have an attribution anchor?" predicate:
 * true exactly when an ACCOUNTS row exists (same predicate the
 * recordSearch INSERT enforces atomically via its footprint subquery —
 * one rule, two enforcements: write-time atomic, read-time for the
 * history route's `attributing` flag). Named for what it checks
 * (accounts), not for the legacy watch concept. Throws on DB failure
 * (no policy here — each caller owns its error semantics: the route
 * fails loud, nothing else calls this).
 */
export const hasAccountFootprint = async (
  steamId: string,
): Promise<boolean> => (await getAccount(steamId)) !== null;

/**
 * Best-effort viewer SteamID64 for search attribution, or null (guest,
 * expired, or a sick session store) — never throws, so attribution can
 * never fail a recording. getSessionSteamId only decrypts the sealed
 * cookie (no network I/O), so guests cost nothing.
 *
 * Deliberately NO footprint check here: recordSearch attributes
 * atomically at INSERT (footprint subquery inside the write
 * transaction — a concurrent opt-out loses the race instead of
 * re-linking, and the write path costs zero extra round-trips).
 * Post-opt-out sessions therefore resolve to their id here but store
 * NULL — optimistic by one row, converged by the transaction. The
 * footprint predicate itself (for the history route's `attributing`
 * flag) lives in hasAccountFootprint below.
 */
export const readSearcherSteamId = async (
  cookieStore: CookieStore,
): Promise<string | null> => {
  try {
    return await getSessionSteamId(cookieStore);
  } catch (error) {
    // Fail-open stays, but not silent: a persistently sick session store
    // would turn every search anonymous (users see an empty history with
    // no signal). Warn once per process — same pattern as the DAL's
    // 020-pending fallback.
    warnSearcherAttributionOnce(
      `searcher attribution skipped (session store failure, fail-open anonymous): ${sanitizeError(error)}`,
    );
    return null;
  }
};
