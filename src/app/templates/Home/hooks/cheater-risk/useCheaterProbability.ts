import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { toast } from 'react-toastify';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { isLoadingType } from '@/@types/isLoadingType';

import { updateCachedSearchById } from '../../shared/cache/homeCache';

import type { RunGuard } from '../run-guard/useRunGuard';

interface UseCheaterProbabilityParams {
  runGuard: RunGuard;
  isLoadingFriendsCards: boolean;
  setIsLoading: Dispatch<SetStateAction<isLoadingType>>;
  targetInfoJson: targetInfoJsonType | undefined;
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  cheaterData: CheaterDataType | undefined;
  setCheaterData: Dispatch<SetStateAction<CheaterDataType | undefined>>;
}

/**
 * getCheaterProbability extracted from useHome.ts, with a deliberate
 * behavioral change: the reactive values the request only needs to READ at
 * call time (isLoadingFriendsCards, targetInfoJson, closeFriendsJson) come
 * from refs instead of from the closure through useCallback deps — this is
 * what keeps the function's identity stable across searches.
 *
 * IMPORTANT: the refs below are synced by DIRECT ASSIGNMENT during render,
 * not inside a useEffect. This is intentional. useEffect callbacks are
 * scheduled and run asynchronously after commit/paint — there's a real
 * (if narrow) window where a ref updated via useEffect could still hold a
 * stale value if something invoked the fetch before that effect had a chance
 * to run. Assigning `ref.current = value` directly in the render body has no
 * such window: it happens synchronously as part of the render that produces
 * the value, so by the time this render commits and any callback can run, the
 * ref is guaranteed current. This is safe specifically because we never READ
 * these refs during render — only inside the async callbacks below.
 *
 * This matters because the actions built here are included in the
 * actionsValue useMemo in HomeProvider.tsx. Every time their identity changed
 * (i.e. on every search), actionsValue ALSO changed — causing any consumer of
 * HomeActionsContext to re-render, even consumers unrelated to the cheater
 * report. That's exactly the re-render the Data/Actions separation was meant
 * to prevent.
 *
 * `prefetchCheaterReport` fires automatically once the target profile has
 * loaded (target + close friends ready), and is the ONLY entry point this hook
 * exposes. It is a pure background fetch — no monetization, no analytics —
 * so an auto-starting slow request on page entry never surfaces modals or
 * pricing toggles without a user click. The click path (useHome's
 * `openCheaterReport`) is what triggers the monetization + analytics side
 * effects and, as a safety net, calls this same fetch when no data is ready.
 *
 * An in-flight guard scoped to the target (not a global boolean) prevents a
 * duplicate request for the SAME player, while still allowing the current
 * player's request to run even if a previous player's is still pending.
 */
const useCheaterProbability = ({
  runGuard,
  isLoadingFriendsCards,
  setIsLoading,
  targetInfoJson,
  closeFriendsJson,
  cheaterData,
  setCheaterData,
}: UseCheaterProbabilityParams) => {
  const { activeRunRef, isCurrentRun } = runGuard;

  // Kept fresh every render, synchronously — see note above. Do not read
  // these during render; only inside the async callbacks below.
  const isLoadingFriendsCardsRef = useRef(isLoadingFriendsCards);
  isLoadingFriendsCardsRef.current = isLoadingFriendsCards;

  const targetInfoJsonRef = useRef(targetInfoJson);
  targetInfoJsonRef.current = targetInfoJson;

  const closeFriendsJsonRef = useRef(closeFriendsJson);
  closeFriendsJsonRef.current = closeFriendsJson;

  // Guards against starting a second /api/getCheaterProbability request for
  // the SAME target while one is already in flight (the prefetch is started by
  // an effect AND can be triggered again by identity churn, or by the click
  // safety-net, before the first resolves). Scoped to the target so a request
  // for a *previous* player never blocks the prefetch of the current one: once
  // the user navigates to B, B's fetch is allowed to run even if A's is still
  // pending (A's stale result is discarded by the run-guard anyway).
  const inFlightTargetRef = useRef<string | null>(null);

  // Whether the last cheater fetch for the current target FAILED (network /
  // provider 429 / other). Distinct from "no data yet": the report shows an
  // error + retry instead of an eternal skeleton. Cleared when a request
  // starts fresh or succeeds.
  const [cheaterError, setCheaterError] = useState(false);

  const performFetch = useCallback(
    async ({
      silent = false,
    }: { silent?: boolean } = {}): Promise<CheaterDataType | null> => {
      const target = targetInfoJsonRef.current?.profileInfo?.steamID;
      const runId = activeRunRef.current;

      if (!target) {
        return null;
      }
      if (inFlightTargetRef.current === target) {
        return null;
      }
      // Defensive: never run the expensive/probability request while the
      // close-friends list is still loading. The score is unreliable without
      // the friends circle (banned-friend analysis would be empty). The UI
      // button already prevents this by disabling until friends settle, but
      // keep the guard as a second line of defense against any other caller.
      if (isLoadingFriendsCardsRef.current) {
        return null;
      }

      inFlightTargetRef.current = target;

      try {
        setIsLoading((prev) => ({ ...prev, cheaterReport: true }));
        setCheaterError(false);

        const response = await axios.post('/api/getCheaterProbability', {
          target,
          closeFriends: closeFriendsJsonRef.current ?? [],
        });

        const cheaterProbability: CheaterDataType = response?.data;

        // Dev-only diagnostics: prints profile nicknames, steamIDs, URLs and
        // ban details — treat as sensitive, never shipped in the prod bundle.
        // eslint-disable-next-line no-restricted-syntax, no-lonely-if
        if (process.env.NODE_ENV !== 'production') {
          console.log('--- Cheater Probability Analysis ---');
          console.log('Probability:', cheaterProbability.cheaterProbability);
          console.log('Features:', cheaterProbability.featureObject);

          if (
            cheaterProbability.featureObject.bannedFriendsDetails &&
            cheaterProbability.featureObject.bannedFriendsDetails.length > 0
          ) {
            console.group('🚨 Banned Friends Detected:');

            cheaterProbability.featureObject.bannedFriendsDetails.forEach(
              (friend) => {
                console.log(`${friend.nickname} (${friend.steamID})`);
                console.log(`URL: ${friend.profileUrl}`);
                console.log(`Bans:`, friend.bans);
                console.log('---');
              },
            );

            console.groupEnd();
          } else {
            console.log('✅ No banned friends found in the analyzed circle.');
          }
        }

        if (!isCurrentRun(runId)) {
          // User has already navigated to another profile — do not apply this
          // result to the state, but still return it to the caller.
          return cheaterProbability;
        }

        setCheaterData(cheaterProbability);

        if (target) {
          updateCachedSearchById(target, {
            cheaterData: cheaterProbability,
          });
        }

        return cheaterProbability;
      } catch (e) {
        if (isCurrentRun(runId)) {
          setCheaterError(true);
          // Throttle/rate-limit/provider failures surface as an error toast
          // ONLY when the request was user-requested (click). The background
          // auto-prefetch must stay silent — showing an error toast for a
          // resource the user never asked for is noise. Always log either way.
          if (!silent) {
            toast.error('Failed to calculate cheater probability');
          }
        }

        // eslint-disable-next-line no-console
        console.error('getCheaterProbability error:', e);

        return null;
      } finally {
        // Only release the lock if it still references our target — a later
        // fetch for a different (newer) player must keep its own lock intact.
        if (inFlightTargetRef.current === target) {
          inFlightTargetRef.current = null;
        }
        if (isCurrentRun(runId)) {
          setIsLoading((prev) => ({
            ...prev,
            cheaterReport: false,
          }));
        }
      }

      // setIsLoading/setCheaterData are useState setters passed through props.
      // They are referentially stable, so including them here does not change
      // the behavior (they never trigger a recreation). This only avoids
      // needing an eslint-disable for exhaustive-deps.
    }, [setIsLoading, setCheaterData, isCurrentRun, activeRunRef]);

  const prefetchCheaterReport = useCallback(
    (options?: { silent?: boolean }) => performFetch(options),
    [performFetch],
  );

  // Auto-start for the slow cheater request once the target profile has fully
  // loaded (target resolved + close friends ready) and we don't already have
  // a result. The report itself stays unmounted until the user opens it, so
  // this background fetch causes no layout shift / LCP / FCP regression — by
  // the time the user clicks, the request is done (or close to done) and the
  // report renders almost instantly.
  //
  // The background fetch is gated on `isCSActive` (enriched server-side by
  // /api/getUserInfo): Counter-Strike must be the user's active game family
  // (>=300h OR top playtime). Cheating probability is only meaningful for CS,
  // so skipping the prefetch for profiles where CS isn't active avoids paying
  // for the expensive work (comment scraping + ban checks + AI model) on the
  // majority of searches that will never relate to CS. This is a cost gate on
  // the AUTOMATIC prefetch only — an explicit click (useHome's
  // openCheaterReport → prefetchCheaterReport safety net) still always fetches,
  // because the user is explicitly asking for the report.
  useEffect(() => {
    const target = targetInfoJson?.profileInfo?.steamID;
    if (!target) {
      return;
    }
    if (cheaterData) {
      return;
    }
    // Never silently re-fire the background prefetch for a target whose auto
    // fetch already FAILED. A reference churn of targetInfoJson/closeFriendsJson
    // (which re-run this effect) would otherwise burn the rate-limited route
    // without the user asking. The explicit retry button (retryCheaterReport)
    // is a separate, visible path and is not affected by this guard.
    if (cheaterError) {
      return;
    }
    if (isLoadingFriendsCards || !closeFriendsJson?.length) {
      return;
    }
    const isCSActive = targetInfoJson?.profileInfo?.isCSActive;
    if (!isCSActive) {
      return;
    }
    // Background auto-prefetch is SILENT: failures are logged but never shown
    // as a toast, because the user never asked for this resource.
    prefetchCheaterReport({ silent: true });
  }, [
    targetInfoJson,
    cheaterData,
    cheaterError,
    isLoadingFriendsCards,
    closeFriendsJson,
    prefetchCheaterReport,
  ]);

  // Re-runs the cheater fetch after a failure (the error is cleared inside
  // performFetch once a request actually starts). This is the "visible" path
  // (as opposed to the silent background prefetch): a re-failure surfaces the
  // error toast. Exposed for the report's retry button.
  //
  // NOTE: intentionally does NOT setCheaterError(false) here. It is cleared
  // inside performFetch once the request actually starts. If the request is
  // aborted early (e.g. isLoadingFriendsCards — no reliable score without the
  // friends circle), clearing the error here would swap the visible
  // "error + Try again" for an eternal skeleton with nothing fetching. When
  // performFetch starts, its try block clears the error for the new attempt.
  const retryCheaterReport = useCallback(
    () => performFetch({ silent: false }),
    [performFetch],
  );

  // Explicitly clears the error state WITHOUT starting a fetch. Called on
  // player switch so a failure from the previous profile can never leak
  // visually into the next one before a fresh fetch has had a chance to run
  // (the error lives here, not in the resetJsons path of useHomeSearch).
  const resetCheaterError = useCallback(() => {
    setCheaterError(false);
  }, []);

  return {
    prefetchCheaterReport,
    cheaterError,
    retryCheaterReport,
    resetCheaterError,
  };
};

export default useCheaterProbability;
