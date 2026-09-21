/**
 * Hover/focus prefetch cache for GET /api/watch/status (avatar-dropdown
 * warm open + skeleton avoidance).
 *
 * Single-identity assumption (explicit decision, not an accident): the
 * entry is keyed by NOTHING because /api/watch/status is self-scoped — it
 * reads identity exclusively from the login session and never accepts a
 * steamId parameter, so within one page lifetime there is exactly one
 * profile this cache can ever describe. Verified by construction: the sole
 * production consumer of useWatchStatus is WatchManager, rendered only
 * inside the logged-in user's own avatar dropdown (SiteNavMenu, session
 * branch) with the session's own steamId. Cross-user leakage would require
 * a login change without a full reload; logout clears the entry anyway
 * (see clearWatchStatusPrefetch) and login flows reload the page. If the
 * hook is ever reused to inspect OTHER profiles, this cache must become
 * keyed by steamId first — the `resets per steamId` test in
 * useWatchStatus.test.ts pins the current contract.
 */
import type { WatchStatusValue } from '@/lib/watchStatus';

export interface PrefetchedWatchStatus {
  status: WatchStatusValue;
  confirmExpired: boolean;
  confirmLinkSent: boolean;
}

/**
 * Shared snapshot shape between the prefetch cache and useWatchStatus:
 * the hook seeds `status`/`confirmExpired`/`confirmLinkSent` (and the
 * welcome-toast `prev` cursor) from exactly this, so the two can never
 * drift apart field by field.
 */
export interface WarmWatchStatusSnapshot {
  status: WatchStatusValue | null;
  confirmExpired: boolean;
  confirmLinkSent: boolean;
}

// Short TTL on purpose: the prefetch is only a hint so the avatar dropdown
// opens warm. The mounted hook always re-polls immediately, so a stale hint
// is corrected within one round trip — 15s bounds how wrong it can be.
const WATCH_STATUS_PREFETCH_TTL_MS = 15000;

let cached: { body: PrefetchedWatchStatus; expiresAt: number } | null = null;
let inflight: Promise<void> | null = null;
// Bumps on every test reset so a stale in-flight chain can never write into
// a fresh test (the chain checks it is still current before storing).
let generation = 0;

/**
 * Single source of truth for "a valid watch status value", shared with
 * useWatchStatus.poll() — add future statuses here, not in both places.
 */
export const isWatchStatusValue = (
  value: unknown,
): value is WatchStatusValue =>
  value === 'pending' || value === 'active' || value === 'none';

/**
 * Validates a /api/watch/status payload into the shape useWatchStatus
 * understands. Same tolerance as the hook: unknown statuses are rejected,
 * missing flag fields default to false instead of failing the whole read.
 */
export const readPrefetchedWatchStatusBody = (
  body: unknown,
): PrefetchedWatchStatus | null => {
  if (typeof body !== 'object' || body === null) return null;
  const record = body as Record<string, unknown>;
  if (!isWatchStatusValue(record.status)) return null;
  return {
    status: record.status,
    confirmExpired: record.confirmExpired === true,
    confirmLinkSent: record.confirmLinkSent === true,
  };
};

/**
 * Peeks at a fresh prefetched entry without consuming it (StrictMode
 * double-mounts must both see it, and reopening within the TTL should stay
 * warm). Returns null when absent or stale.
 */
export const getPrefetchedWatchStatus =
  (): PrefetchedWatchStatus | null => {
    if (cached === null) return null;
    if (Date.now() > cached.expiresAt) {
      cached = null;
      return null;
    }
    return cached.body;
  };

/**
 * Single read of the warm state with hook-ready defaults. Use this (never
 * `getPrefetchedWatchStatus()?.field ?? default` inline) so every seeding
 * site reads one consistent snapshot.
 */
export const readWarmWatchStatusSnapshot =
  (): WarmWatchStatusSnapshot => {
    const warm = getPrefetchedWatchStatus();
    return {
      status: warm?.status ?? null,
      confirmExpired: warm?.confirmExpired ?? false,
      confirmLinkSent: warm?.confirmLinkSent ?? false,
    };
  };

/**
 * Warms the watch-status cache ahead of the dropdown opening. Fire-and-
 * forget by design — callers never await it.
 *
 * Laziness contract (do not weaken: this must never cost initial load):
 * - only ever called from post-paint user intent (avatar hover/focus), so
 *   FCP/LCP/TTFB are unaffected by construction — no mount/idle prefetch;
 * - single-flight + freshness guard, so repeated hovers cost at most one
 *   tiny same-origin GET per TTL window;
 * - hidden tabs skip entirely; failures are swallowed (the normal poll is
 *   the fallback, and the skeleton covers the gap CLS-wise either way).
 */
export const prefetchWatchStatus = (): void => {
  if (typeof window === 'undefined') return;
  // No fetch (SSR edge, test envs without a mock): never throw from an
  // event handler — the normal poll + skeleton remain the fallback.
  if (typeof fetch !== 'function') return;
  if (
    typeof document !== 'undefined' &&
    document.visibilityState === 'hidden'
  ) {
    return;
  }
  if (getPrefetchedWatchStatus() !== null) return;
  if (inflight !== null) return;
  const seen = generation;
  // A fetch impl that throws synchronously (hand-rolled mocks) must not
  // propagate out of a React event handler either — assignment stays
  // synchronous so rapid double-hovers still single-flight.
  let chain: Promise<void>;
  try {
    chain = fetch('/api/watch/status')
      .then((res) => {
        if (!res.ok) return null;
        return res.json().catch(() => null);
      })
      .then((body: unknown) => {
        if (seen !== generation) return;
        const parsed = readPrefetchedWatchStatusBody(body);
        if (parsed !== null) {
          cached = {
            body: parsed,
            expiresAt: Date.now() + WATCH_STATUS_PREFETCH_TTL_MS,
          };
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (seen === generation) inflight = null;
      });
  } catch {
    return;
  }
  inflight = chain;
};

/**
 * Updates the cache with a live poll result. Called by useWatchStatus
 * after a successful poll so that a reopen within the TTL reflects the
 * latest known state instead of the stale hover snapshot. This prevents
 * duplicate welcome toasts when the dropdown is reopened within the TTL
 * after a real pending→active transition has already been observed.
 */
export const updatePrefetchedWatchStatus = (
  body: PrefetchedWatchStatus,
): void => {
  cached = {
    body,
    expiresAt: Date.now() + WATCH_STATUS_PREFETCH_TTL_MS,
  };
};

/**
 * Clears the cache. Test seam (the cache outlives single calls by design),
 * and logout hygiene: the next login is a different session that must never
 * read this one's hint. A full page reload wipes module state anyway — this
 * is belt-and-braces for a future client-side logout without reload.
 */
export const clearWatchStatusPrefetch = (): void => {
  generation += 1;
  cached = null;
  inflight = null;
};
