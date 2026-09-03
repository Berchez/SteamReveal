import axios from 'axios';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'react-toastify';
import { useLocale, useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType, {
  LocationInfoType,
  EnrichedUserSummary,
} from '@/@types/targetInfoJsonType';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { isLoadingType } from '@/@types/isLoadingType';

import {
  computeCloseFriendsProbability,
  computeCityScores,
  computeLocationProbabilities,
} from './probabilityMath';

import {
  getLocationDetails,
  getCitiesNames,
  sortCitiesByScore,
} from './homeUtils';

import { getCachedSearch, setCachedSearch } from '../../shared/cache/homeCache';

import {
  recordAnalytics,
  getRequesterDevice,
  getRequesterCountry,
  getRequesterBrowserLanguage,
} from '../../shared/analytics/homeAnalyticsUtils';

import type { RunGuard } from '../run-guard/useRunGuard';

const getCloseFriendsCore = async (id: string) => {
  const {
    data: { closeFriends },
  } = await axios.post('/api/getCloseFriends', {
    target: id,
  });

  return computeCloseFriendsProbability(closeFriends);
};

interface UseHomeSearchParams {
  runGuard: RunGuard;
  syncPlayerUrl: (steamId: string) => void;
  consumeSyncedUrlPlayer: (urlPlayer: string | undefined) => boolean;
  clearSyncedUrlPlayer: () => void;
  handleShowSponsorMe: () => void;
  handleShowSupportMe: (days: number) => void;
}

type CloseFriendsJsonState = closeFriendsDataIWant[] | undefined;
type PossibleLocationJsonState = locationDataIWant[] | undefined;
type ResolvedTargetInfoJson = {
  profileInfo: EnrichedUserSummary;
  targetLocationInfo: LocationInfoType;
};

/**
 * Owns the state for "what is currently being displayed for this profile":
 * profileInfo, close friends, probable location, client-side cache, and the
 * search cycle triggered by URL navigation. cheaterData/isLoading remain
 * here (rather than in useCheaterProbability) because they are part of the
 * same "profile changed" reset as the others — resetJsons() clears all five
 * together.
 */
const useHomeSearch = ({
  runGuard,
  syncPlayerUrl,
  consumeSyncedUrlPlayer,
  clearSyncedUrlPlayer,
  handleShowSponsorMe,
  handleShowSupportMe,
}: UseHomeSearchParams) => {
  const { reserveNewRun, isCurrentRun } = runGuard;

  const routeParams = useParams<{ steamId?: string }>();

  const locale = useLocale();

  const translator = useTranslations('ServerMessages');

  const urlPlayer = routeParams?.steamId;

  const initialCache = urlPlayer ? getCachedSearch(urlPlayer) : undefined;

  // The active search's id, kept reactive so downstream effects (e.g. the
  // cheater-report analytics attach in useHome) can react to it arriving.
  const [searchId, setSearchId] = useState<string | null>(
    initialCache?.searchId ?? null,
  );

  const targetValue = useRef<string | null>(null);

  const [closeFriendsJson, setCloseFriendsJson] =
    useState<CloseFriendsJsonState>(initialCache?.closeFriendsJson);

  const [possibleLocationJson, setPossibleLocationJson] =
    useState<PossibleLocationJsonState>(initialCache?.possibleLocationJson);

  // If the URL already names a player and we have no cached result to show
  // immediately, a fetch is about to kick off synchronously in the effect
  // below (handleGetInfoClick -> getUserInfoJson -> getCloseFriendsJson).
  // Starting `isLoading` at `false` and only flipping it to `true` once
  // that effect runs meant the very first paint computed `hasNoDataYet` as
  // `true` (see Home.tsx) — mounting the empty-state hero
  // (WelcomeText/SupportedFormatsSection/PostHeroSections) and the
  // absolute/centered layout, only to unmount/reposition everything one
  // frame later when the effect set isLoading.myCard. Same story for
  // LocationSection, which renders `null` while its own loading flag is
  // false and `possibleLocationJson` is undefined, then pops in with a
  // skeleton once it flips. Both were significant, avoidable CLS sources
  // on every non-cached player-page load. Seeding the initial state here
  // means the first render already reflects "we're loading this player",
  // so the skeletons render from paint #1 and nothing has to unmount.
  //
  // NOTE: this default only reflects what's known synchronously at the
  // time this hook first runs (the client-side cache). Whether the page
  // was ALSO server-rendered with a profile (see seedInitialProfile below)
  // is not knowable yet here — HomeProvider (which owns this hook) is an
  // *ancestor* of the page/Home component that carries that data, so on
  // the very first render it genuinely hasn't arrived. That gap is closed
  // a few microtasks later, before paint, by the layout effect below —
  // not by changing this initializer.
  const startsLoading = Boolean(urlPlayer) && !initialCache;

  const [isLoading, setIsLoading] = useState<isLoadingType>({
    myCard: startsLoading,
    friendsCards: startsLoading,
    // Dedicated flag for LocationSection. It must NOT reuse friendsCards:
    // getCloseFriendsJson flips friendsCards to false as soon as it
    // resolves, but getPossibleLocation (which produces possibleLocationJson)
    // only starts AFTER that, awaited sequentially in handleGetInfoClick.
    // Reusing friendsCards here meant LocationSection's `!possibleLocationJson
    // && !isLoading` guard went true during that gap and the whole section
    // (title + card/skeleton) unmounted, then popped back in once
    // getPossibleLocation resolved — on every single non-cached search.
    location: startsLoading,
    cheaterReport: false,
  });

  const [cheaterData, setCheaterData] = useState<CheaterDataType | undefined>(
    initialCache?.cheaterData,
  );

  const [targetInfoJson, setTargetInfoJson] = useState<
    targetInfoJsonType | undefined
  >(initialCache?.targetInfoJson);

  // ---- Server-rendered profile handoff -------------------------------
  //
  // Home.tsx (a descendant of HomeProvider) receives `initialProfile` as a
  // prop straight from page.tsx (server) and, on mount, calls
  // `actions.seedInitialProfile(initialProfile)` from a useLayoutEffect.
  // React fires layout effects bottom-up on the initial commit — child
  // (Home) before parent (this hook, inside HomeProvider) — and layout
  // effects run *before* the browser paints. So by the time the
  // useLayoutEffect below runs, seededProfileRef is already populated,
  // and any setState it triggers is folded into the same pre-paint
  // commit. Net effect: when the SSR profile matches the current URL,
  // the user never sees a skeleton for MyUserSection at all — not "less
  // flicker", zero flicker.
  //
  // Plain refs (not state) are used for both seededProfileRef and
  // appliedSeedForRef so writing/reading them has no render/timing race
  // of its own — only the eventual setTargetInfoJson/setIsLoading calls
  // are state, and those are intentionally synchronous with the layout
  // effect for the reason above.
  const seededProfileRef = useRef<{
    steamId: string;
    profile: EnrichedUserSummary;
  } | null>(null);

  const appliedSeedForRef = useRef<string | null>(null);

  const seedInitialProfile = useCallback(
    (profile: EnrichedUserSummary | undefined) => {
      if (!profile) {
        return;
      }
      seededProfileRef.current = { steamId: profile.steamID, profile };
    },
    [],
  );

  useLayoutEffect(() => {
    if (
      urlPlayer &&
      !initialCache &&
      seededProfileRef.current?.steamId === urlPlayer &&
      appliedSeedForRef.current !== urlPlayer
    ) {
      appliedSeedForRef.current = urlPlayer;

      setTargetInfoJson({
        profileInfo: seededProfileRef.current.profile,
        // Left empty on purpose: resolving country/state/city names is a
        // local lookup (getLocationDetails), not a Steam API call, but it
        // still needs to run somewhere — it happens right after, in
        // getSeededUserInfoJson, without blocking this pre-paint seed.
        // LocationCardSkeleton is responsible for not reshaping itself
        // when this later fills in — see that component.
        targetLocationInfo: {},
      });

      setIsLoading((prev) => ({ ...prev, myCard: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPlayer]);

  const getPossibleLocation = async (
    closeFriendsOfTheTarget: closeFriendsDataIWant[],
    runId: number,
  ) => {
    const citiesScored = sortCitiesByScore(
      computeCityScores(closeFriendsOfTheTarget),
    );

    const citiesScoredWithNames = await getCitiesNames(citiesScored);

    const withProbability = computeLocationProbabilities(citiesScoredWithNames);

    if (isCurrentRun(runId)) {
      setPossibleLocationJson(withProbability);
    }

    return withProbability;
  };

  const getUserInfoJson = async (
    value: string,
    runId: number,
  ): Promise<ResolvedTargetInfoJson> => {
    try {
      if (isCurrentRun(runId)) {
        setIsLoading((prev) => ({ ...prev, myCard: true }));
      }

      const { data } = await axios.post('/api/getUserInfo', {
        target: value,
      });

      const { targetInfo } = data;

      const locationInfo = await getLocationDetails(
        targetInfo.countryCode,
        targetInfo.stateCode,
        targetInfo.cityID,
      );

      const newTargetInfoJson: targetInfoJsonType = {
        profileInfo: targetInfo,
        targetLocationInfo: locationInfo,
      };

      if (!isCurrentRun(runId)) {
        return newTargetInfoJson;
      }

      setTargetInfoJson(newTargetInfoJson);

      if (targetInfo.steamID !== urlPlayer) {
        syncPlayerUrl(targetInfo.steamID);
      }

      return newTargetInfoJson;
    } catch (e) {
      if (isCurrentRun(runId)) {
        toast.error(translator('invalidPlayer'));
      }
      console.error(e);
      throw e;
    } finally {
      if (isCurrentRun(runId)) {
        setIsLoading((prev) => ({ ...prev, myCard: false }));
      }
    }
  };
  // Used instead of getUserInfoJson when the profile card was already
  // seeded pre-paint from the server-rendered profile (see the layout
  // effect above). The nickname/avatar/etc are already correct and already
  // on screen — this only resolves the location lookup, so it never
  // touches isLoading.myCard (no skeleton flash) and never re-hits Steam
  // for data we already have.
  const getSeededUserInfoJson = async (
    runId: number,
  ): Promise<ResolvedTargetInfoJson> => {
    const profileInfo = seededProfileRef.current?.profile;
    if (!profileInfo) {
      return getUserInfoJson(urlPlayer as string, runId);
    }
    try {
      const locationInfo = await getLocationDetails(
        profileInfo.countryCode,
        profileInfo.stateCode,
        profileInfo.cityID,
      );
      const enrichedTargetInfoJson: targetInfoJsonType = {
        profileInfo,
        targetLocationInfo: locationInfo,
      };
      if (isCurrentRun(runId)) {
        setTargetInfoJson(enrichedTargetInfoJson);
      }
      return enrichedTargetInfoJson;
    } catch (e) {
      // Location enrichment failing must not take down an already-valid,
      // already-rendered profile card the way getUserInfoJson's failure
      // would (that one throws and aborts the whole search). Fall back to
      // the seeded profile with an empty location and let friends/cheater
      // data proceed normally.
      console.error('getSeededUserInfoJson (location) error:', e);
      return { profileInfo, targetLocationInfo: {} };
    }
  };
  const getCloseFriendsJson = async (value: string, runId: number) => {
    try {
      setIsLoading((prev) => ({ ...prev, friendsCards: true }));
      const closeFriendsWithProbability = await getCloseFriendsCore(value);
      if (isCurrentRun(runId)) {
        setCloseFriendsJson(closeFriendsWithProbability);
      }
      return closeFriendsWithProbability;
    } catch (e) {
      if (isCurrentRun(runId)) {
        toast.error(translator('friendsNotPublic'));
      }
      console.error(e);
      throw e;
    } finally {
      if (isCurrentRun(runId)) {
        setIsLoading((prev) => ({ ...prev, friendsCards: false }));
      }
    }
  };
  const resetJsons = (
    preserveProfile?: targetInfoJsonType,
    startLoading = false,
  ) => {
    setCloseFriendsJson(undefined);
    setPossibleLocationJson(undefined);
    setTargetInfoJson(preserveProfile);
    setCheaterData(undefined);
    setSearchId(null);
    if (startLoading) {
      // Only when a new profile search is actually starting (see call site
      // in handleGetInfoClick). The other call site — clearing state
      // because urlPlayer became undefined, i.e. user navigated back to
      // the home/welcome screen — must NOT force isLoading true here,
      // since nothing will ever flip it back to false (no fetch is
      // starting), which would permanently hide the welcome hero via
      // hasNoDataYet in Home.tsx. That branch resets isLoading to false
      // explicitly itself instead (see the effect below).
      setIsLoading((prev) => ({
        ...prev,
        // If we're preserving an already-seeded profile, its card is
        // already correct and on screen — do not show a skeleton for it.
        myCard: !preserveProfile,
        friendsCards: true,
        location: true,
        cheaterReport: false,
      }));
    }
  };
  const handleGetInfoClick = async (value: string, alreadySeeded = false) => {
    const runId = reserveNewRun();
    const cached = getCachedSearch(value);
    if (cached) {
      handleShowSponsorMe();
      handleShowSupportMe(1);
      setTargetInfoJson(cached.targetInfoJson);
      setCloseFriendsJson(cached.closeFriendsJson);
      setPossibleLocationJson(cached.possibleLocationJson);
      setCheaterData(cached.cheaterData);
      setSearchId(cached.searchId ?? null);
      const cachedSteamId = cached.targetInfoJson?.profileInfo?.steamID;
      if (cachedSteamId && cachedSteamId !== urlPlayer) {
        syncPlayerUrl(cachedSteamId);
      }
      return;
    }
    handleShowSponsorMe();
    handleShowSupportMe(1);
    if (alreadySeeded) {
      // The profile card is already seeded and on screen (see layout
      // effect above) — only reset the heavier/secondary data, and keep
      // myCard's loading flag as the layout effect left it (false).
      setCloseFriendsJson(undefined);
      setPossibleLocationJson(undefined);
      setCheaterData(undefined);
      setSearchId(null);
      setIsLoading((prev) => ({
        ...prev,
        friendsCards: true,
        location: true,
        cheaterReport: false,
      }));
    } else {
      resetJsons(undefined, true);
    }
    const startedAt = Date.now();
    try {
      const newTargetInfoJson: ResolvedTargetInfoJson = alreadySeeded
        ? await getSeededUserInfoJson(runId)
        : await getUserInfoJson(value, runId);
      if (!isCurrentRun(runId)) {
        return;
      }
      const closeFriends = await getCloseFriendsJson(value, runId);
      if (!isCurrentRun(runId)) {
        return;
      }
      let possibleLocation: locationDataIWant[] | undefined;
      let resolvedSearchId: string | null = null;
      const cacheSearch = () => {
        setCachedSearch(value, newTargetInfoJson.profileInfo.steamID, {
          targetInfoJson: newTargetInfoJson,
          closeFriendsJson: closeFriends,
          possibleLocationJson: possibleLocation ?? [],
          searchId: resolvedSearchId,
        });
      };
      try {
        possibleLocation = await getPossibleLocation(closeFriends, runId);
      } catch (e) {
        if (isCurrentRun(runId)) {
          toast.error(translator('invalidPlayer'));
        }
        console.error('getPossibleLocation error:', e);
        if (isCurrentRun(runId)) {
          cacheSearch();
        }
        return;
      } finally {
        // Must fire on every path (success, thrown error, or the early
        // `return` above) — this is the flag LocationSection now uses, and
        // leaving it stuck true would permanently show a skeleton.
        if (isCurrentRun(runId)) {
          setIsLoading((prev) => ({ ...prev, location: false }));
        }
      }
      if (!isCurrentRun(runId)) {
        return;
      }
      try {
        resolvedSearchId = await recordAnalytics(
          newTargetInfoJson.profileInfo,
          closeFriends,
          possibleLocation,
          {
            requesterLocale: locale ?? null,
            requesterCountry: getRequesterCountry(),
            requesterBrowserLanguage: getRequesterBrowserLanguage(),
            device: getRequesterDevice(),
            durationMs: Date.now() - startedAt,
          },
        );
      } catch (e) {
        console.error('recordAnalytics error:', e);
        resolvedSearchId = null;
      }
      if (!isCurrentRun(runId)) {
        return;
      }
      setSearchId(resolvedSearchId);
      cacheSearch();
    } catch (e) {
      // Ensure loading flags are cleared on any failure so skeletons don't
      // remain visible indefinitely (e.g. invalid player causing getUserInfo
      // to throw before friends/location fetches run). Individual fetch
      // helpers already show toasts; just reset UI-loading state here.
      if (isCurrentRun(runId)) {
        setIsLoading({
          myCard: false,
          friendsCards: false,
          location: false,
          cheaterReport: false,
        });
      }
    }
  };
  useEffect(() => {
    if (!urlPlayer) {
      clearSyncedUrlPlayer();
      reserveNewRun();
      resetJsons();
      // Explicit, unconditional reset: if the user navigates back to the
      // home/welcome screen while a fetch was still in flight, reserveNewRun()
      // above just invalidated that run — its own finally blocks are now
      // guarded by isCurrentRun and will never fire, so isLoading could
      // otherwise stay stuck mid-loading forever (and, via hasNoDataYet,
      // permanently hide the welcome hero).
      setIsLoading({
        myCard: false,
        friendsCards: false,
        location: false,
        cheaterReport: false,
      });
      appliedSeedForRef.current = null;
      return;
    }
    if (consumeSyncedUrlPlayer(urlPlayer)) {
      return;
    }
    handleGetInfoClick(urlPlayer, appliedSeedForRef.current === urlPlayer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlPlayer]);
  const onChangeTarget = useCallback((value: string) => {
    targetValue.current = value;
  }, []);
  const hasNoDataYet = !targetInfoJson && !isLoading.myCard;
  return {
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
  };
};
export default useHomeSearch;
