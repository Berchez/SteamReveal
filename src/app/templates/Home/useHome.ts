import axios from 'axios';
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useLocale, useTranslations } from 'next-intl';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { useParams, useSearchParams } from 'next/navigation';
import { useRouter } from '@/navigation';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { isLoadingType } from '@/@types/isLoadingType';
import useSupportMe from '@/app/components/SupportMe/useSupportMe';
import { track } from '@vercel/analytics';
import { UserSummary } from 'steamapi';

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

import {
  getCachedSearch,
  setCachedSearch,
  updateCachedSearchById,
} from './homeCache';

import NAVIGATION_OWNED_PARAMS from './navigationParams';

export async function fetchSteamId(target: string) {
  const response = await axios.get('/api/getSteamId', {
    params: {
      target,
    },
  });

  return response.data.steamId;
}

const getCloseFriendsCore = async (id: string) => {
  const {
    data: { closeFriends },
  } = await axios.post('/api/getCloseFriends', {
    target: id,
  });

  return computeCloseFriendsProbability(closeFriends);
};

// ---- Analytics helpers -------------------------------------------------

const getRequesterDevice = (): 'mobile' | 'desktop' | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'mobile'
    : 'desktop';
};

const getRequesterCountry = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.body.getAttribute('data-country');
};

const ANALYTICS_SKIP_PASSWORD_KEY = 'analytics_skip_password';

export const getAnalyticsSkipHeaders = ():
  | Record<string, string>
  | undefined => {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    const skipPassword = localStorage.getItem(ANALYTICS_SKIP_PASSWORD_KEY);
    return skipPassword
      ? { 'x-analytics-skip-password': skipPassword }
      : undefined;
  } catch (e) {
    return undefined;
  }
};

type AnalyticsMeta = {
  requesterLocale: string | null;
  requesterCountry: string | null;
  device: 'mobile' | 'desktop' | null;
  durationMs: number | null;
};

const recordAnalytics = async (
  targetInfo: UserSummary | undefined,
  closeFriends: closeFriendsDataIWant[] | undefined,
  possibleLocation: locationDataIWant[] | undefined,
  meta: AnalyticsMeta,
): Promise<string | null> => {
  if (!targetInfo?.steamID) {
    return null;
  }

  let targetGcName: string | null = null;
  try {
    const { data } = await axios.post('/api/getGamersClubName', {
      steamId: targetInfo.steamID,
    });
    targetGcName = data.gcName;
  } catch (e) {
    // Best effort, ignore failures
  }

  try {
    const payload = {
      profile: {
        steamId: targetInfo.steamID,
        steamUrl: targetInfo.url ?? null,
        nickname: targetInfo.nickname ?? null,
        gcName: targetGcName,
        countryCode: targetInfo.countryCode ?? null,
        stateCode: targetInfo.stateCode ?? null,
        cityId: targetInfo.cityID ?? null,
      },
      friends: (closeFriends ?? []).map((f) => ({
        steamId: f.friend.steamID,
        nickname: f.friend.nickname ?? null,
        gcName: null,
        mutualCount: f.count ?? null,
        probability: f.probability ?? null,
        countryCode: f.friend.countryCode ?? null,
      })),
      locationGuess: (possibleLocation ?? []).slice(0, 3).map((l) => ({
        location: l.location,
        probability: l.probability,
      })),
      requesterLocale: meta.requesterLocale,
      requesterCountry: meta.requesterCountry,
      device: meta.device,
      durationMs: meta.durationMs,
    };

    const { data } = await axios.post('/api/recordAnalytics', payload, {
      headers: getAnalyticsSkipHeaders(),
    });

    if (data?.skipped) {
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    console.error('[Analytics] Failed to record search:', e);
    return null;
  }
};

const useHome = () => {
  const router = useRouter();
  const routeParams = useParams<{ steamId?: string }>();
  const searchParams = useSearchParams();
  const locale = useLocale();

  const { showSponsorMe, handleShowSponsorMe, onCloseSponsorMe } =
    useSponsorMe();

  const { showSupportMe, handleShowSupportMe, onCloseSupportMe } =
    useSupportMe();

  // Builds `/player/<id>` while preserving any *other* query params
  // already on the URL (utm_*, referral tags, feature flags, etc) — the
  // old `updateQueryParam` did this by construction (it merged into
  // existing params); the string-template version introduced when the
  // route moved to `/player/[steamId]` silently dropped them.
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

  const urlPlayer = routeParams?.steamId;
  const initialCache = urlPlayer ? getCachedSearch(urlPlayer) : undefined;

  const lastSearchIdRef = useRef<string | null>(initialCache?.searchId ?? null);
  const runIdCounterRef = useRef(0);

  // Identifies which "profile session" is currently active. Every effect
  // or callback that writes async-resolved state to React state must check
  // this before writing — otherwise a slow request for a profile the user
  // has already navigated away from can clobber state that belongs to the
  // profile now on screen. This isn't limited to the initial fetch: any
  // async action tied to "the profile currently being viewed" (location
  // guessing, cheater probability, etc) needs to respect the same guard.
  const activeRunRef = useRef<number | null>(null);

  // Reserves a new run id and marks it as the active one *synchronously* —
  // this is what makes any async work belonging to a previous run get
  // rejected by the `activeRunRef.current !== runId` guards below, even if
  // that older run's promise resolves before this new run's own fetch has
  // even started (e.g. user searches A, then immediately searches B before
  // A's request comes back).
  const reserveNewRun = useCallback(() => {
    runIdCounterRef.current += 1;
    activeRunRef.current = runIdCounterRef.current;
    return runIdCounterRef.current;
  }, []);

  // User-initiated navigation (explicit search/click) — pushes a new
  // history entry. Wrapped in useCallback so it has a stable identity
  // across renders; HomeProvider relies on that to avoid re-rendering
  // every consumer of HomeActionsContext on every unrelated state change.
  const navigateToPlayer = useCallback(
    (steamId: string) => {
      // Invalidate whatever run is currently in flight *before* the URL
      // even changes — router.push() itself is async/deferred, so without
      // this a slow-resolving previous search can still win the race and
      // paint over the profile the user just navigated to.
      reserveNewRun();
      router.push(buildPlayerHref(steamId), { scroll: false });
    },
    [router, buildPlayerHref, reserveNewRun],
  );

  // Holds the steamId of the *most recent* internal URL sync (see
  // `syncPlayerUrl` below), so the effect that watches `urlPlayer` can tell
  // "the URL changed because we resolved a vanity name mid-run" apart from
  // "the URL changed because of a real navigation (user action, back/
  // forward, direct link)".
  const syncedUrlPlayerRef = useRef<string | null>(null);

  // Silently keeps the URL in sync with state resolved internally.
  // Uses replace so these internal syncs never pollute browser history —
  // only navigateToPlayer (explicit user action) should do that.
  const syncPlayerUrl = (steamId: string) => {
    syncedUrlPlayerRef.current = steamId;
    router.replace(buildPlayerHref(steamId), { scroll: false });
  };

  const targetValue = useRef<string | null>();
  const translator = useTranslations('ServerMessages');

  const [closeFriendsJson, setCloseFriendsJson] = useState<
    closeFriendsDataIWant[] | undefined
  >(initialCache?.closeFriendsJson);

  const [possibleLocationJson, setPossibleLocationJson] = useState<
    locationDataIWant[] | undefined
  >(initialCache?.possibleLocationJson);

  const [isLoading, setIsLoading] = useState<isLoadingType>({
    myCard: false,
    friendsCards: false,
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

    if (activeRunRef.current === runId) {
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

      if (activeRunRef.current !== runId) {
        return newTargetInfoJson;
      }

      setTargetInfoJson(newTargetInfoJson);

      if (targetInfo.steamID !== urlPlayer) {
        syncPlayerUrl(targetInfo.steamID);
      }

      return newTargetInfoJson;
    } catch (e) {
      if (activeRunRef.current === runId) {
        toast.error(translator('invalidPlayer'));
      }
      console.error(e);
      throw e;
    } finally {
      if (activeRunRef.current === runId) {
        setIsLoading((prev) => ({ ...prev, myCard: false }));
      }
    }
  };

  const getCloseFriendsJson = async (value: string, runId: number) => {
    try {
      setIsLoading((prev) => ({ ...prev, friendsCards: true }));
      const closeFriendsWithProbability = await getCloseFriendsCore(value);

      if (activeRunRef.current === runId) {
        setCloseFriendsJson(closeFriendsWithProbability);
      }

      return closeFriendsWithProbability;
    } catch (e) {
      if (activeRunRef.current === runId) {
        toast.error(translator('friendsNotPublic'));
      }
      console.error(e);
      throw e;
    } finally {
      if (activeRunRef.current === runId) {
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

  const getCheaterProbability: () => Promise<CheaterDataType | null> =
    useCallback(async () => {
      if (isLoading.friendsCards) {
        return null;
      }
      const target = targetInfoJson?.profileInfo?.steamID;
      const runId = activeRunRef.current;

      try {
        handleShowSupportMe(3);
        setIsLoading((prev) => ({ ...prev, cheaterReport: true }));

        track('cheater_probability_requested', { target: target ?? '' });

        const response = await axios.post('/api/getCheaterProbability', {
          target,
          closeFriends: closeFriendsJson ?? [],
        });

        const cheaterProbability: CheaterDataType = response?.data;
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

        if (activeRunRef.current !== runId) {
          // User already navigated to a different profile — don't apply
          // this result to state, but still return it to the caller.
          return cheaterProbability;
        }

        setCheaterData(cheaterProbability);

        if (target) {
          updateCachedSearchById(target, { cheaterData: cheaterProbability });
        }

        if (lastSearchIdRef.current) {
          axios
            .post(
              '/api/recordAnalyticsCheater',
              {
                searchId: lastSearchIdRef.current,
                score: cheaterProbability.cheaterProbability,
                bannedFriendsCount:
                  cheaterProbability.featureObject.bannedFriendsDetails
                    ?.length ?? 0,
              },
              {
                headers: getAnalyticsSkipHeaders(),
              },
            )
            .catch((e) => {
              console.error(
                '[Analytics] Failed to attach cheater probability:',
                e,
              );
            });
        }

        return cheaterProbability;
      } catch (e) {
        if (activeRunRef.current === runId) {
          toast.error('Failed to calculate cheater probability');
        }
        console.error('getCheaterProbability error:', e);
        return null;
      } finally {
        if (activeRunRef.current === runId) {
          setIsLoading((prev) => ({ ...prev, cheaterReport: false }));
        }
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [
      isLoading.friendsCards,
      targetInfoJson,
      closeFriendsJson,
      handleShowSupportMe,
    ]);

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

      if (activeRunRef.current !== runId) {
        return;
      }

      const closeFriends = await getCloseFriendsJson(value, runId);

      if (activeRunRef.current !== runId) {
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
        if (activeRunRef.current === runId) {
          toast.error(translator('invalidPlayer'));
        }
        console.error('getPossibleLocation error:', e);

        if (activeRunRef.current === runId) {
          cacheSearch();
        }
        return;
      }

      if (activeRunRef.current !== runId) {
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

      if (activeRunRef.current !== runId) {
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
      syncedUrlPlayerRef.current = null;

      reserveNewRun();

      resetJsons();
      return;
    }

    if (syncedUrlPlayerRef.current === urlPlayer) {
      syncedUrlPlayerRef.current = null;
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
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    getCheaterProbability,
    navigateToPlayer,
    showSupportMe,
    onCloseSupportMe,
  };
};

export default useHome;
