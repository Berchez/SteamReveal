/**
 * Watch notify hook (WB-12) — enqueues a `notify` event after a search is
 * recorded, when a watch is active for the searched profile.
 *
 * Gates (all reused from the Epic 1 DAL, no duplicated rules):
 * 1. a single getWatchedProfile read must show status `active`;
 * 2. no notification in the cooldown window (shared
 *    @/lib/watch/cooldown predicate over the row's last_notified_at);
 * 3. this search_id must not have produced a notify yet (enqueueEvent's
 *    UNIQUE(search_id) + catch-and-re-read — safe under concurrency,
 *    restarts, and double submits).
 *
 * One read, not two: an earlier version fanned out to getWatchStatus +
 * isWithinCooldown in parallel, but both hit the SAME watched_profiles
 * row — a single getWatchedProfile covers status and clock together,
 * halving the extra cost this hook adds to the hottest write route.
 *
 * Never throws by contract: analytics must not fail because the watch
 * pipeline did. Every failure (DAL down, bad ids, enqueue collision that
 * resolves oddly) logs structurally and resolves to
 * `{ enqueued: false }`. Callers await only this fast enqueue step (never
 * the Steam delivery, which is bot-owned) — and even a contract-breaking
 * rejection must keep analytics green, hence the defensive .catch at the
 * call site.
 *
 * Cooldown nuance (inherited from the Epic 1 design, kept deliberately):
 * the 24h clock advances when a notify is SENT (markEventSent), not when
 * it is enqueued. Two rapid searches can therefore queue two notifies
 * before either sends — at-least-once delivery beats a lost notification,
 * and once any send lands the clock suppresses everything further for
 * the full window.
 */

import { enqueueEvent, getWatchedProfile } from './db';
import isWithinCooldownWindow from '../watch/cooldown';

/** Max 1 notification per steamId per this many hours (Epic 5 decision). */
export const NOTIFY_COOLDOWN_HOURS = 24;

export type WatchNotifyReason =
  | 'not-active'
  | 'cooldown'
  | 'duplicate'
  | 'error';

export type WatchNotifyOutcome =
  | { enqueued: true; eventId: number | null }
  | { enqueued: false; reason: WatchNotifyReason };

export interface WatchNotifyLogger {
  error: (message: string) => void;
}

export const enqueueWatchNotification = async (
  steamId: string,
  searchId: string,
  logger: WatchNotifyLogger = console,
): Promise<WatchNotifyOutcome> => {
  try {
    // Both gates come from this one row: status for the opt-in check,
    // last_notified_at for the cooldown check.
    const profile = await getWatchedProfile(steamId);
    if (profile === null || profile.status !== 'active') {
      return { enqueued: false, reason: 'not-active' };
    }
    if (isWithinCooldownWindow(profile.lastNotifiedAt, NOTIFY_COOLDOWN_HOURS)) {
      return { enqueued: false, reason: 'cooldown' };
    }
    const { eventId, duplicate } = await enqueueEvent(
      steamId,
      'notify',
      searchId,
    );
    return duplicate
      ? { enqueued: false, reason: 'duplicate' }
      : { enqueued: true, eventId };
  } catch (error) {
    // Swallowed by design (see header): analytics continues. steamId and
    // searchId are public data (searchable on the site); no secrets ever
    // flow through this module, so there is nothing sensitive to leak here
    // by construction.
    logger.error(
      `[Watch] notify hook failed: steamId=${steamId} searchId=${searchId}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { enqueued: false, reason: 'error' };
  }
};
