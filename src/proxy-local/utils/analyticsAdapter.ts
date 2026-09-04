/**
 * Analytics write adapter — picks the storage backend at runtime.
 *
 * The proxy's /api/analytics/{record,cheater} endpoints call recordSearch()
 * / attachCheaterProbability() from here instead of from utils/analytics.ts
 * directly. Which backend handles the write is decided per call:
 *
 *   - DATABASE_URL set  → Turso (src/lib/analytics/db.ts) is canonical.
 *     After each write the analytics.html dashboard is regenerated FROM THE
 *     TURSO DATA via the new db.getSearchRecords() read path, keeping the
 *     dashboard file a pure rendered view (never a second source of truth).
 *   - DATABASE_URL unset → the historical JSON-file store
 *     (utils/analytics.ts) behaves exactly as before, so a proxy without
 *     Turso credentials keeps working for local dev.
 *
 * The SearchRecord contract (including `id`, returned so the frontend can
 * attach the cheater result later) is identical on both paths.
 */
import {
  recordSearch as jsonRecordSearch,
  attachCheaterProbability as jsonAttachCheaterProbability,
  refreshDashboard,
} from './analytics';
import {
  recordSearch as tursoRecordSearch,
  attachCheaterProbability as tursoAttachCheaterProbability,
  getSearchRecords,
} from '../../lib/analytics/db';

import type {
  CheaterProbabilityRecord,
  NewSearchInput,
  SearchRecord,
} from './analytics';

const isTursoConfigured = (): boolean => Boolean(process.env.DATABASE_URL);

// Serializes dashboard HTML regeneration. The Turso write itself is a single
// atomic batch so concurrent recordSearch() calls are fine; but two concurrent
// read-all + write-html refreshes would race on the same .tmp file, so the
// refresh is queued like the JSON path's writeQueue.
let dashboardQueue: Promise<void> = Promise.resolve();

const refreshDashboardFromTurso = (): Promise<void> => {
  const task = dashboardQueue.then(async () => {
    await refreshDashboard(await getSearchRecords());
  });
  dashboardQueue = task.catch(() => undefined);
  return task;
};

export const recordSearch = async (
  input: NewSearchInput,
): Promise<SearchRecord> => {
  if (!isTursoConfigured()) {
    return jsonRecordSearch(input);
  }

  const record = await tursoRecordSearch(input);

  // The search is already durable (Turso batch committed). A dashboard
  // regeneration failure only stales the rendered view — don't fail the
  // request because of it, or the client would retry and duplicate the search.
  try {
    await refreshDashboardFromTurso();
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn('[Analytics] Search recorded, but dashboard refresh failed:', error);
  }

  return record;
};

export const attachCheaterProbability = async (
  searchId: string,
  cheater: CheaterProbabilityRecord,
): Promise<boolean> => {
  if (!isTursoConfigured()) {
    return jsonAttachCheaterProbability(searchId, cheater);
  }

  const updated = await tursoAttachCheaterProbability(searchId, cheater);

  if (updated) {
    try {
      await refreshDashboardFromTurso();
    } catch (error) {
      // eslint-disable-next-line no-console
      console.warn('[Analytics] Cheater result attached, but dashboard refresh failed:', error);
    }
  }

  return updated;
};