import { useCallback, useRef } from 'react';

import { useSearchParams } from 'next/navigation';

import { useRouter } from '@/navigation';

import NAVIGATION_OWNED_PARAMS from './navigationParams';

/**
 * Isolates everything that interacts with the player's URL: building the href,
 * explicit user navigation (push, creates history), and silent internal
 * synchronization (replace, does not create history — e.g. a vanity URL being
 * resolved to a SteamID64).
 *
 * Receives `reserveNewRun` from outside (from useRunGuard) instead of owning
 * its own run guard: navigateToPlayer needs to invalidate any in-progress run
 * BEFORE router.push, and that invalidation must use the same guard as the
 * rest of the search — two independent guards would not see each other.
 */
const usePlayerUrlSync = (reserveNewRun: () => number) => {
  const router = useRouter();

  const searchParams = useSearchParams();

  const buildPlayerHref = useCallback(
    (steamId: string) => {
      const params = new URLSearchParams(searchParams.toString());

      NAVIGATION_OWNED_PARAMS.forEach((key) => params.delete(key));

      const query = params.toString();

      const path = `/player/${encodeURIComponent(steamId)}`;

      return query ? `${path}?${query}` : path;
    },
    [searchParams],
  );

  const navigateToPlayer = useCallback(
    (steamId: string) => {
      // Invalidate the in-progress run BEFORE the URL changes — router.push()
      // is asynchronous/deferred, so without this, a previous slow search
      // could still win the race and overwrite the newly navigated profile.
      reserveNewRun();

      router.push(buildPlayerHref(steamId), { scroll: false });
    },
    [router, buildPlayerHref, reserveNewRun],
  );

  // Stores the last INTERNAL URL sync so the consumer observing `urlPlayer`
  // can distinguish between "the URL changed because we resolved a vanity
  // name during the current run" and "the URL changed due to an actual
  // navigation" (user action, back/forward button, direct link).
  //
  // Kept private to this hook — callers get consumeSyncedUrlPlayer /
  // clearSyncedUrlPlayer instead of the raw ref, so the mutation never
  // crosses a module boundary (avoids no-param-reassign on a ref passed
  // through props, and keeps the "what is a synced URL" concept owned by
  // the one hook that actually writes it).
  const syncedUrlPlayerRef = useRef<string | null>(null);

  const syncPlayerUrl = useCallback(
    (steamId: string) => {
      syncedUrlPlayerRef.current = steamId;

      router.replace(buildPlayerHref(steamId), { scroll: false });
    },
    [router, buildPlayerHref],
  );

  // Returns true (and consumes/clears the marker) if `urlPlayer` matches the
  // last internal sync — meaning the caller should treat this URL change as
  // already-handled and skip re-fetching.
  const consumeSyncedUrlPlayer = useCallback(
    (urlPlayer: string | undefined) => {
      if (syncedUrlPlayerRef.current === urlPlayer) {
        syncedUrlPlayerRef.current = null;

        return true;
      }

      return false;
    },
    [],
  );

  const clearSyncedUrlPlayer = useCallback(() => {
    syncedUrlPlayerRef.current = null;
  }, []);

  return {
    navigateToPlayer,
    syncPlayerUrl,
    consumeSyncedUrlPlayer,
    clearSyncedUrlPlayer,
  };
};

export default usePlayerUrlSync;
