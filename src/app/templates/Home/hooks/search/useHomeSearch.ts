import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useLocale, useTranslations } from 'next-intl';
import { useParams } from 'next/navigation';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
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

  const lastSearchIdRef = useRef<string | null>(initialCache?.searchId ?? null);

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
  // LocationSection, which renders `null` while `isLoading.friendsCards`
  // is false and `possibleLocationJson` is undefined, then pops in with a
  // skeleton once it flips. Both were significant, avoidable CLS sources
  // on every non-cached player-page load. Seeding the initial state here
  // means the first render already reflects "we're loading this player",
  // so the skeletons render from paint #1 and nothing has to unmount.
  const startsLoading = Boolean(urlPlayer) && !initialCache;

  const [isLoading, setIsLoading] = useState<isLoadingType>({
    myCard: startsLoading,
    friendsCards: startsLoading,
    cheaterReport: false,
  });

  const [cheaterData, setCheaterData] = useState<CheaterDataType | undefined>(
    initialCache?.cheaterData,
  );

  const [targetInfoJson, setTargetInfoJson] = useState<
    targetInfoJsonType | undefined
  >(initialCache?.targetInfoJson);

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

  const getUserInfoJson = async (value: string, runId: number) => {
    try {
      setIsLoading((prev) => ({ ...prev, myCard: true }));

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

  const resetJsons = () => {
    setCloseFriendsJson(undefined);
    setPossibleLocationJson(undefined);
    setTargetInfoJson(undefined);
    setCheaterData(undefined);
    lastSearchIdRef.current = null;
  };

  const handleGetInfoClick = async (value: string) => {
    const runId = reserveNewRun();

    const cached = getCachedSearch(value);

    if (cached) {
      handleShowSponsorMe();
      handleShowSupportMe(1);

      setTargetInfoJson(cached.targetInfoJson);
      setCloseFriendsJson(cached.closeFriendsJson);
      setPossibleLocationJson(cached.possibleLocationJson);
      setCheaterData(cached.cheaterData);

      lastSearchIdRef.current = cached.searchId ?? null;

      const cachedSteamId = cached.targetInfoJson?.profileInfo?.steamID;

      if (cachedSteamId && cachedSteamId !== urlPlayer) {
        syncPlayerUrl(cachedSteamId);
      }

      return;
    }

    handleShowSponsorMe();
    handleShowSupportMe(1);

    resetJsons();

    const startedAt = Date.now();

    try {
      const newTargetInfoJson = await getUserInfoJson(value, runId);

      if (!isCurrentRun(runId)) {
        return;
      }

      const closeFriends = await getCloseFriendsJson(value, runId);

      if (!isCurrentRun(runId)) {
        return;
      }

      let possibleLocation: locationDataIWant[] | undefined;

      let searchId: string | null = null;

      const cacheSearch = () => {
        setCachedSearch(value, newTargetInfoJson.profileInfo.steamID, {
          targetInfoJson: newTargetInfoJson,
          closeFriendsJson: closeFriends,
          possibleLocationJson: possibleLocation ?? [],
          searchId,
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
      }

      if (!isCurrentRun(runId)) {
        return;
      }

      try {
        searchId = await recordAnalytics(
          newTargetInfoJson.profileInfo,
          closeFriends,
          possibleLocation,
          {
            requesterLocale: locale ?? null,
            requesterCountry: getRequesterCountry(),
            device: getRequesterDevice(),
            durationMs: Date.now() - startedAt,
          },
        );
      } catch (e) {
        console.error('recordAnalytics error:', e);
        searchId = null;
      }

      if (!isCurrentRun(runId)) {
        return;
      }

      lastSearchIdRef.current = searchId;

      cacheSearch();
    } catch (e) {
      // getUserInfoJson/getCloseFriendsJson already show their own toasts
    }
  };

  useEffect(() => {
    if (!urlPlayer) {
      clearSyncedUrlPlayer();

      reserveNewRun();

      resetJsons();

      return;
    }

    if (consumeSyncedUrlPlayer(urlPlayer)) {
      return;
    }

    handleGetInfoClick(urlPlayer);

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
    lastSearchIdRef,
  };
};

export default useHomeSearch;
