import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'react-toastify';

import type { WatchStatusValue } from '@/lib/watchStatus';

import { isSteamId64 } from '@/lib/steamId';

import {
  isWatchStatusValue,
  readWarmWatchStatusSnapshot,
  updatePrefetchedWatchStatus,
} from './watchStatusPrefetch';

/** Default poll cadence: 12/min, far below the 30/min per-IP route cap. */
export const WATCH_POLL_INTERVAL_MS = 5000;

/** Backoff ceiling for transient failures (never exceeds this). */
const BACKOFF_CAP_MS = 60000;

interface UseWatchStatusOptions {
  steamId: string | null | undefined;
  enabled?: boolean;
  pollIntervalMs?: number;
}

interface UseWatchStatusResult {
  status: WatchStatusValue | null;
  /** Only definitive failures surface here: 'invalid' id, or
   * 'session-expired' (logged out / expired mid-use — callers show the
   * login gate). Transient network errors keep polling silently until
   * unmount. */
  error: string | null;
  /** Whether the confirm link died unclicked (drives the resend UI).
   * Additive and best-effort: false until a poll says otherwise, and a
   * body without the field keeps the previous value. */
  confirmExpired: boolean;
  /** Whether a confirmation link generation exists (live or expired —
   * issue writes hash + expiry together, consume clears both). Used by
   * the UI to show "check your chat" hint instead of the invite hint
   * when the link has already been sent. */
  confirmLinkSent: boolean;
}

/**
 * Polls GET /api/watch/status for one profile (WB-10) and fires the
 * welcome toast exactly once when it flips pending -> active (WB-11).
 *
 * Single self-scheduling setTimeout chain: the next tick is only armed
 * after the previous fetch settles, so concurrent polls are impossible by
 * construction (no guard flag needed). Transient failures (network, 429,
 * 5xx, malformed body) back off exponentially up to 60s instead of
 * hammering at full cadence; background tabs skip fetching entirely.
 * Everything resets per steamId and all timers die on
 * unmount/disable/steamId-change.
 *
 * Welcome dedup rules (each structural, not timer-based):
 * - transition-gated: only prev === 'pending' && next === 'active' fires;
 * - fresh loads start with prev === null, so opening directly on an
 *   already-active watch (or after a reload) never toasts;
 * - welcomedForRef pins the toast to one steamId, so StrictMode remounts
 *   and repeated polls can never double-fire.
 */
export const useWatchStatus = ({
  steamId,
  enabled = true,
  pollIntervalMs = WATCH_POLL_INTERVAL_MS,
}: UseWatchStatusOptions): UseWatchStatusResult => {
  const translator = useTranslations('Watch');
  // Warm start from the avatar hover/focus prefetch (when fresh): the first
  // paint already shows real content instead of the skeleton, so opening
  // the dropdown right after hovering never flashes. Absent/stale reads
  // fall back to the skeleton path exactly as before — and the poll below
  // always revalidates on mount, so a stale hint self-corrects in one tick.
  // Single lazy read: the three states below seed from one consistent
  // snapshot instead of calling the getter three times.
  const [initialWarm] = useState(readWarmWatchStatusSnapshot);
  const [status, setStatus] = useState<WatchStatusValue | null>(
    initialWarm.status,
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmExpired, setConfirmExpired] = useState(
    initialWarm.confirmExpired,
  );
  const [confirmLinkSent, setConfirmLinkSent] = useState(
    initialWarm.confirmLinkSent,
  );
  const prevStatusRef = useRef<WatchStatusValue | null>(null);
  const welcomedForRef = useRef<string | null>(null);
  // Mirror of the two flag states for the prefetch-cache sync below. poll()
  // closes over the mount-time scope (empty deps), so it cannot read the
  // current state directly — and the sync must use the *resolved* values
  // (absent body fields keep the previous value), never the raw body.
  const confirmExpiredRef = useRef(false);
  const confirmLinkSentRef = useRef(false);
  // Store the welcome message in a ref to avoid recreating poll when locale changes
  const welcomeMessageRef = useRef<string>('');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Update the welcome message ref when translator changes
  useEffect(() => {
    welcomeMessageRef.current = translator('watchWelcome');
  }, [translator]);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const poll = useCallback(
    async (
      id: string,
      signal?: AbortSignal,
    ): Promise<'ok' | 'backoff' | 'stop'> => {
      let res: Response;
      try {
        res = await fetch('/api/watch/status', { signal });
      } catch {
        // Transient network failure: back off and keep polling (the
        // unmount cleanup bounds the loop; only definitive errors stop it).
        return 'backoff';
      }
      if (!res.ok) {
        if (res.status === 400) {
          setError('invalid');
          return 'stop';
        }
        if (res.status === 401) {
          // Session died mid-use (logout elsewhere, expiry): stop polling
          // and surface the login gate — retrying an unauthenticated poll
          // would only burn the rate-limit budget.
          setError('session-expired');
          return 'stop';
        }
        // 429/5xx: back off instead of hammering at full cadence (several
        // open tabs would otherwise self-throttle against the per-IP cap).
        return 'backoff';
      }
      const body = (await res.json().catch(() => null)) as {
        status?: unknown;
        confirmExpired?: unknown;
        confirmLinkSent?: unknown;
      } | null;
      const next = body?.status;
      if (!isWatchStatusValue(next)) {
        return 'backoff';
      }
      if (body?.confirmExpired === true) {
        setConfirmExpired(true);
        confirmExpiredRef.current = true;
      } else if (body?.confirmExpired === false) {
        setConfirmExpired(false);
        confirmExpiredRef.current = false;
      }
      if (body?.confirmLinkSent === true) {
        setConfirmLinkSent(true);
        confirmLinkSentRef.current = true;
      } else if (body?.confirmLinkSent === false) {
        setConfirmLinkSent(false);
        confirmLinkSentRef.current = false;
      }
      // Absent field (old deployments mid-rollout): keep the previous
      // value instead of flapping the resend UI every other tick.
      const prev = prevStatusRef.current;
      prevStatusRef.current = next;
      setStatus(next);
      if (
        prev === 'pending' &&
        next === 'active' &&
        welcomedForRef.current !== id
      ) {
        welcomedForRef.current = id;
        toast.success(welcomeMessageRef.current);
      }
      // Sync the prefetch cache with the live poll result so that a
      // reopen within the TTL reflects the latest known state and avoids
      // duplicate welcome toasts on remount. Uses the resolved ref values —
      // never the raw body — so an absent field keeps the previous value
      // here exactly as it does for the rendered state above.
      updatePrefetchedWatchStatus({
        status: next,
        confirmExpired: confirmExpiredRef.current,
        confirmLinkSent: confirmLinkSentRef.current,
      });
      return next === 'active' ? 'stop' : 'ok';
    },
    [], // No dependencies - welcomeMessageRef is stable, toast is stable
  );

  useEffect(() => {
    // Seed from the same prefetch as the useState initializers above:
    // without this the mount effect would wipe a warm first paint back to
    // the skeleton (a content → skeleton → content flash). Same-value sets
    // bail out in React, so the cold path is unaffected. The welcome-toast
    // cursor seeds from the snapshot too: a warm 'pending' that flips to
    // 'active' on the first real poll must still toast exactly once.
    const warmSnapshot = readWarmWatchStatusSnapshot();
    prevStatusRef.current = warmSnapshot.status;
    setStatus(warmSnapshot.status);
    setError(null);
    setConfirmExpired(warmSnapshot.confirmExpired);
    confirmExpiredRef.current = warmSnapshot.confirmExpired;
    setConfirmLinkSent(warmSnapshot.confirmLinkSent);
    confirmLinkSentRef.current = warmSnapshot.confirmLinkSent;
    clearTimer();
    if (!enabled || !steamId) return undefined;
    // Defense-in-depth: the id arrives server-verified via page props, but
    // a malformed prop must fail loudly ('invalid') instead of polling.
    if (!isSteamId64(steamId)) {
      setError('invalid');
      return undefined;
    }
    let cancelled = false;
    let consecutiveFailures = 0;
    // Aborts the in-flight status fetch on unmount / steamId change. Without
    // this, a close→reopen sequence can leave two polls racing: the dead
    // instance's fetch still resolves and toasts (its prev cursor is warm
    // 'pending' too), duplicating the welcome toast the new instance also
    // fires. The abort rejection lands in poll()'s catch as 'backoff' and
    // the cancelled tick below drops it — plus one wasted request saved.
    const controller = new AbortController();
    const tick = async (): Promise<void> => {
      timerRef.current = null;
      let delayMs = pollIntervalMs;
      // Background tab: skip the fetch (saves requests/battery at scale
      // with many watchers idling) but keep the chain alive — the next
      // tick retries on visibility return. Only 'hidden' pauses: any other
      // state (visible, prerender, jsdom) polls normally.
      if (
        typeof document === 'undefined' ||
        document.visibilityState !== 'hidden'
      ) {
        const action = await poll(steamId, controller.signal);
        if (cancelled || action === 'stop') return;
        if (action === 'backoff') {
          consecutiveFailures += 1;
          delayMs = Math.min(
            pollIntervalMs * 2 ** consecutiveFailures,
            BACKOFF_CAP_MS,
          );
        } else {
          consecutiveFailures = 0;
        }
      }
      if (cancelled) return;
      timerRef.current = setTimeout(() => {
        tick();
      }, delayMs);
    };
    tick();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimer();
    };
  }, [steamId, enabled, pollIntervalMs, poll, clearTimer]);

  return { status, error, confirmExpired, confirmLinkSent };
};
