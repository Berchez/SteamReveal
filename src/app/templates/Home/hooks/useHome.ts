import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { track } from '@vercel/analytics';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import useSupportMe from '@/app/components/SupportMe/useSupportMe';

import { useRunGuard } from './run-guard/useRunGuard';
import usePlayerUrlSync from './url-sync/usePlayerUrlSync';
import useHomeSearch from './search/useHomeSearch';
import useCheaterProbability from './cheater-risk/useCheaterProbability';
import { getAnalyticsSkipHeaders } from '../shared/analytics/homeAnalyticsUtils';

export { getAnalyticsSkipHeaders } from '../shared/analytics/homeAnalyticsUtils';

export async function fetchSteamId(target: string) {
  const response = await axios.get('/api/getSteamId', {
    params: {
      target,
    },
  });

  return response.data.steamId;
}

/**
 * Composition root: connects the specialized hooks to each other and returns
 * the combined interface consumed by HomeProvider.tsx / Home.tsx / context.ts
 * (openCheaterReport, retryCheaterReport, cheaterError, isReportOpen...).
 */
const useHome = () => {
  const runGuard = useRunGuard();

  const { showSponsorMe, handleShowSponsorMe, onCloseSponsorMe } =
    useSponsorMe();

  const { showSupportMe, handleShowSupportMe, onCloseSupportMe } =
    useSupportMe();

  const {
    navigateToPlayer,
    syncPlayerUrl,
    consumeSyncedUrlPlayer,
    clearSyncedUrlPlayer,
  } = usePlayerUrlSync(runGuard.reserveNewRun);

  const {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    setIsLoading,
    hasNoDataYet,
    cheaterData,
    setCheaterData,
    searchId,
    seedInitialProfile,
  } = useHomeSearch({
    runGuard,
    syncPlayerUrl,
    consumeSyncedUrlPlayer,
    clearSyncedUrlPlayer,
    handleShowSponsorMe,
    handleShowSupportMe,
  });

  const { prefetchCheaterReport, cheaterError, retryCheaterReport, resetCheaterError } =
    useCheaterProbability({
      runGuard,
      isLoadingFriendsCards: isLoading.friendsCards,
      setIsLoading,
      targetInfoJson,
      closeFriendsJson,
      cheaterData,
      setCheaterData,
    });

  // ---- Cheater report open/close ------------------------------------
  //
  // The report section is NOT mounted on load — it only mounts once the user
  // opens it (gated in Home.tsx on isReportOpen). This is what keeps the
  // auto-starting prefetch (prefetchCheaterReport, above) from causing any
  // CLS/LCP/FCP regression: the fetch runs in the background, but no DOM is
  // produced at that spot until the user actually clicks. Opening the report
  // also fires the monetization + analytics side effects, since those are
  // deliberately gated behind the user action ("só no clique").
  const [isReportOpen, setIsReportOpen] = useState(false);

  // Kept in a ref (assigned synchronously during render) so openCheaterReport
  // can read the current open state and the target WITHOUT depending on them —
  // keeping the action's identity stable for HomeProvider's actionsValue memo
  // (a Data/Actions consumer like the button must not re-render on every
  // loading tick).
  const isReportOpenRef = useRef(false);
  isReportOpenRef.current = isReportOpen;

  const targetInfoJsonRef = useRef(targetInfoJson);
  targetInfoJsonRef.current = targetInfoJson;

  // Synced synchronously during render so openCheaterReport can decide whether
  // to kick off a safety-net fetch WITHOUT depending on cheaterData (keeping
  // the action's identity stable for HomeProvider's actionsValue memo).
  const cheaterDataRef = useRef(cheaterData);
  cheaterDataRef.current = cheaterData;

  // Mirrors useCheaterProbability's cheaterError so openCheaterReport can
  // tell "background prefetch already failed" from "not fetched yet". When a
  // background attempt already failed, opening the report must NOT re-fire the
  // non-silent safety-net fetch (that would surface an error toast the user
  // never asked for and burn another rate-limited attempt) — the report should
  // instead show the existing error + "Try again" state.
  const cheaterErrorRef = useRef(cheaterError);
  cheaterErrorRef.current = cheaterError;

  // One-way open: clicking the button mounts the report and there is no way to
  // dismiss it afterwards (except a refresh / navigating to another player).
  // Repeated clicks are no-ops, so the monetization + analytics side effects
  // fire exactly once, on the first open.
  const openCheaterReport = useCallback(() => {
    if (isReportOpenRef.current) {
      return;
    }
    isReportOpenRef.current = true;
    setIsReportOpen(true);
    handleShowSupportMe(3);
    track('cheater_probability_requested', {
      target: targetInfoJsonRef.current?.profileInfo?.steamID ?? '',
    });

    // Safety net: if the background prefetch hasn't produced data AND hasn't
    // failed yet, start the fetch now so the skeleton shows and the data
    // eventually lands. If the background attempt already failed (cheaterError),
    // leave the existing error + "Try again" state in place — the user can
    // explicitly retry from there instead of re-hitting a rate-limited route on
    // a click they didn't intend as a retry. performFetch is idempotent per
    // player via its own in-flight guard, so this is safe to call here.
    if (!cheaterDataRef.current && !cheaterErrorRef.current) {
      prefetchCheaterReport();
    }
  }, [handleShowSupportMe, prefetchCheaterReport]);

  // Close the report whenever the displayed profile changes (new search,
  // navigation back home) so a stale report never lingers across players.
  const lastSeenSteamIdRef = useRef<string | null>(null);
  useEffect(() => {
    const steamId = targetInfoJson?.profileInfo?.steamID ?? null;
    if (steamId === lastSeenSteamIdRef.current) {
      return;
    }
    lastSeenSteamIdRef.current = steamId;
    if (isReportOpenRef.current) {
      isReportOpenRef.current = false;
      setIsReportOpen(false);
    }
    // A previous profile's failure must not leak into the next one: the
    // cheaterError lives in useCheaterProbability (not in useHomeSearch's
    // resetJsons), so the explicit reset here closes the window where a
    // stale error could show before a fresh fetch runs for the new target.
    //
    // ORDERING: this effect is declared AFTER useCheaterProbability, so on the
    // render where targetInfoJson switches to a new player,
    // useCheaterProbability's auto-prefetch effect runs first and still sees
    // the OLD player's global cheaterError=true — causing it to skip one
    // prefetch attempt for the new target. This effect then clears the error
    // (setCheaterError(false)), the re-render re-runs the prefetch effect with
    // cheaterError=false, and the prefetch fires one tick later. That one-tick
    // delay is imperceptible (the prefetch is a background warm-up that mounts
    // no DOM until the user clicks), and the coupling is deliberate and
    // self-correcting — keep these two in this declaration order.
    resetCheaterError();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetInfoJson]);

  // Attach the cheater probability to the active search — analytics ONLY for
  // a deliberate user action (the report is open). This is a `useEffect` so
  // it fires regardless of ordering between the click, the prefetch, AND the
  // search-id arriving (all three are reactive deps):
  //  - click BEFORE the data lands  → fires when cheaterData becomes available
  //  - data lands BEFORE the click  → fires when the report is opened
  //  - searchId lands LAST (recordAnalytics slower than the cheater fetch) →
  //    fires when the reactive searchId is finally set
  // A per-player guard guarantees it fires exactly once, so the background
  // prefetch (which never sets isReportOpen) never triggers it on its own.
  // A `Set` (not a single ref value) so that going A → B → back to A (cache
  // hit) does not re-send the analytics event for A — each steamId is only
  // ever attached once per session.
  const cheaterAnalyticsSentForRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!isReportOpen) {
      return;
    }
    const steamId = targetInfoJson?.profileInfo?.steamID ?? null;
    if (!steamId || !cheaterData || !searchId) {
      return;
    }
    if (cheaterAnalyticsSentForRef.current.has(steamId)) {
      return;
    }
    cheaterAnalyticsSentForRef.current.add(steamId);

    axios
      .post(
        '/api/recordAnalyticsCheater',
        {
          searchId,
          score: cheaterData.cheaterProbability,
          bannedFriendsCount:
            cheaterData.featureObject?.bannedFriendsDetails?.length ?? 0,
        },
        {
          headers: getAnalyticsSkipHeaders(),
        },
      )
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error('[Analytics] Failed to attach cheater probability:', e);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReportOpen, cheaterData, targetInfoJson, searchId]);

  return {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    showSupportMe,
    onCloseSupportMe,
    seedInitialProfile,
    isReportOpen,
    cheaterError,
    openCheaterReport,
    retryCheaterReport,
    navigateToPlayer,
  };
};

export default useHome;
