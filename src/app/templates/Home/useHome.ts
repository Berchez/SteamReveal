import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useLocale, useTranslations } from 'next-intl';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { useSearchParams } from 'next/navigation';
import { usePathname, useRouter } from '@/navigation';
import { cityNameAndScore } from '@/@types/cityNameAndScore';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { isLoadingType } from '@/@types/isLoadingType';
import useSupportMe from '@/app/components/SupportMe/useSupportMe';
import { track } from '@vercel/analytics';
import { UserSummary } from 'steamapi';

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

export async function fetchSteamId(target: string) {
  const response = await axios.get('/api/getSteamId', {
    params: {
      target,
    },
  });

  return response.data.steamId;
}

const getCloseFriendsCore = async (id: string) => {
  const response = await axios.post('/api/getCloseFriends', {
    target: id,
  });

  const {
    data: { closeFriends },
  } = response;

  let totalCountOf5ClosestFriends = 0;
  for (let i = 0; i < 5; i += 1) {
    totalCountOf5ClosestFriends += closeFriends[i].count;
  }

  const meanOf5ClosestFriendsCount = totalCountOf5ClosestFriends / 5;

  const biggestCountValue = closeFriends[0].count;
  const reasonableNumberToBeAGoodGuess = 50;

  const closeFriendsWithProbability = closeFriends.map(
    (f: closeFriendsDataIWant) => {
      const meanProbabilityMethod =
        f.count / (meanOf5ClosestFriendsCount * 1.5) > 1
          ? 1
          : f.count / (meanOf5ClosestFriendsCount * 1.5);

      const biggestCountMethod = f.count / biggestCountValue;

      const constantMethod =
        f.count / reasonableNumberToBeAGoodGuess > 1
          ? 1
          : f.count / reasonableNumberToBeAGoodGuess;

      const probabilityFloat =
        (meanProbabilityMethod * 2 + biggestCountMethod * 2 + constantMethod) /
        5;

      const probabilityPercentage = probabilityFloat * 100;

      return {
        friend: f.friend,
        count: f.count,
        probability: probabilityPercentage,
      };
    },
  );

  return closeFriendsWithProbability;
};

// ---- Analytics helpers -------------------------------------------------

/** Rough mobile/desktop split, purely for the analytics dashboard's device breakdown. */
const getRequesterDevice = (): 'mobile' | 'desktop' | null => {
  if (typeof navigator === 'undefined') {
    return null;
  }
  return /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'mobile'
    : 'desktop';
};

/** Same attribute the GamersClub name lookup already relies on (set by middleware). */
const getRequesterCountry = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }
  return document.body.getAttribute('data-country');
};

const ANALYTICS_SKIP_PASSWORD_KEY = 'analytics_skip_password';

/**
 * Reads the (optional) analytics skip password from localStorage and turns
 * it into request headers for the recordAnalytics* endpoints. Returns
 * `undefined` when there's no `window` (SSR), no password stored, or when
 * localStorage throws (e.g. some private-browsing modes) — in all of those
 * cases the request should just go out without the skip header.
 *
 * Exported (in addition to the default hook) so it can be unit tested on
 * its own, without pulling in the rest of useHome's dependencies.
 */
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

/**
 * Records a finished search to analytics.html (via /api/recordAnalytics ->
 * local proxy). Returns the created record's id so a cheater-probability
 * score can be attached to this exact search later, or null if recording
 * failed/was skipped — callers should treat that as "no id, don't attach".
 */
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

    // When the request was skipped (e.g. dev/testing via the skip
    // password), there's no real record on the other end — don't return
    // a fake id, or it'll be forwarded as `searchId` to
    // /api/recordAnalyticsCheater later.
    if (data?.skipped) {
      return null;
    }

    return data?.id ?? null;
  } catch (e) {
    // Best effort, ignore failures — analytics should never block the UI.
    console.error('[Analytics] Failed to record search:', e);
    return null;
  }
};

const useHome = () => {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const locale = useLocale();

  const { showSponsorMe, handleShowSponsorMe, onCloseSponsorMe } =
    useSponsorMe();

  const { showSupportMe, handleShowSupportMe, onCloseSupportMe } =
    useSupportMe();

  // Uses the next-intl-aware router/pathname so the locale prefix and any
  // existing query params survive the update (a plain `?${...}` string
  // href doesn't reliably resolve against the current locale-prefixed
  // path here).
  const updateQueryParam = (key: string, value: string) => {
    const currentParams = new URLSearchParams(searchParams.toString());
    currentParams.set(key, value);
    router.replace(
      { pathname, query: Object.fromEntries(currentParams.entries()) },
      { scroll: false },
    );
  };

  const targetValue = useRef<string | null>();
  const translator = useTranslations('ServerMessages');

  // Id of the most recently recorded search, so a cheater-probability score
  // computed afterwards can be attached to the right entry in analytics.html.
  const lastSearchIdRef = useRef<string | null>(null);

  const [closeFriendsJson, setCloseFriendsJson] = useState<
    closeFriendsDataIWant[] | undefined
  >();

  const [possibleLocationJson, setPossibleLocationJson] = useState<
    locationDataIWant[] | undefined
  >();

  const [isLoading, setIsLoading] = useState<isLoadingType>({
    myCard: false,
    friendsCards: false,
    cheaterReport: false,
  });

  const [cheaterData, setCheaterData] = useState<CheaterDataType>();

  const urlPlayer = searchParams.get('player');

  const [targetInfoJson, setTargetInfoJson] = useState<targetInfoJsonType>();

  const getPossibleLocation = async (
    closeFriendsOfTheTarget: closeFriendsDataIWant[],
  ) => {
    const closeFriendsWithCities = closeFriendsOfTheTarget.filter(
      (f: closeFriendsDataIWant) => f.friend.cityID !== undefined,
    );

    let citiesScored: cityNameAndScore = {};
    closeFriendsWithCities.forEach((f: closeFriendsDataIWant) => {
      const cityKey = `${f.friend.countryCode}/${f.friend.stateCode}/${f.friend.cityID}`;

      citiesScored[cityKey] = citiesScored[cityKey]
        ? citiesScored[cityKey] * f.count
        : f.count;
    });

    citiesScored = sortCitiesByScore(citiesScored);

    const citiesScoredWithNames = await getCitiesNames(citiesScored);

    let totalCountOfScores = 0;
    citiesScoredWithNames.forEach((c) => {
      totalCountOfScores += c.count;
    });

    const reasonableNumberToBeAGoodGuess = 100;

    const withProbability = citiesScoredWithNames.map((c) => {
      const totalCountMethod =
        totalCountOfScores === 0 ? 0 : c.count / totalCountOfScores;

      const constantMethod =
        c.count > reasonableNumberToBeAGoodGuess
          ? 1
          : c.count / reasonableNumberToBeAGoodGuess;

      const probabilityFloat = (totalCountMethod * 2 + constantMethod) / 3;
      const probabilityPercentage = probabilityFloat * 100;

      return {
        location: c.location,
        count: c.count,
        probability: probabilityPercentage,
      };
    });

    setPossibleLocationJson(withProbability);

    return withProbability;
  };

  const getUserInfoJson = async (value: string) => {
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

      setTargetInfoJson(newTargetInfoJson);

      updateQueryParam('player', targetInfo.steamID);

      return newTargetInfoJson;
    } catch (e) {
      toast.error(translator('invalidPlayer'));
      console.error(e);
      throw e;
    } finally {
      setIsLoading((prev) => ({ ...prev, myCard: false }));
    }
  };

  const getCloseFriendsJson = async (value: string) => {
    try {
      setIsLoading((prev) => ({ ...prev, friendsCards: true }));
      const closeFriendsWithProbability = await getCloseFriendsCore(value);

      setCloseFriendsJson(closeFriendsWithProbability);

      return closeFriendsWithProbability;
    } catch (e) {
      toast.error(translator('friendsNotPublic'));
      console.error(e);
      throw e;
    } finally {
      setIsLoading((prev) => ({ ...prev, friendsCards: false }));
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
    async () => {
      if (isLoading.friendsCards) {
        return null;
      }
      const target = targetInfoJson?.profileInfo?.steamID;

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

        setCheaterData(cheaterProbability);

        // NOTE: reuses the `target` resolved at the top of this function —
        // previously this was redeclared here, which shadowed the outer
        // `target` instead of causing an error, but was confusing and
        // pointless since both are the same value.
        if (target) {
          updateCachedSearchById(target, { cheaterData: cheaterProbability });
        }

        // Attach this score to the search that was already recorded, so the
        // dashboard can show cheater-probability insights without every
        // search needing to compute one. Fire-and-forget: never block the UI.
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
        toast.error('Failed to calculate cheater probability');
        console.error('getCheaterProbability error:', e);
        return null;
      } finally {
        setIsLoading((prev) => ({ ...prev, cheaterReport: false }));
      }
    };

  const handleGetInfoClick = async (value: string) => {
    const cached = getCachedSearch(value);
    if (cached) {
      // Still surface the sponsor/support prompts on a cache-hit — they
      // gate on their own internal cooldown, and skipping them here would
      // mean a repeated search never shows them. `resetJsons()` isn't
      // needed since every piece of state it would clear gets overwritten
      // by the cached values right below anyway.
      handleShowSponsorMe();
      handleShowSupportMe(1);

      setTargetInfoJson(cached.targetInfoJson);
      setCloseFriendsJson(cached.closeFriendsJson);
      setPossibleLocationJson(cached.possibleLocationJson);
      setCheaterData(cached.cheaterData);
      lastSearchIdRef.current = cached.searchId ?? null;

      const cachedSteamId = cached.targetInfoJson?.profileInfo?.steamID;
      // Only touch the URL if it's actually out of sync — the common case
      // (e.g. a cache hit from switching locale with the same player) has
      // urlPlayer already pointing at this steamId, so skip the no-op replace.
      if (cachedSteamId && cachedSteamId !== urlPlayer) {
        updateQueryParam('player', cachedSteamId);
      }

      return;
    }

    handleShowSponsorMe();
    handleShowSupportMe(1);
    resetJsons();

    const startedAt = Date.now();

    const newTargetInfoJson = await getUserInfoJson(value);
    const closeFriends = await getCloseFriendsJson(value);
    const possibleLocation = await getPossibleLocation(closeFriends);

    const searchId = await recordAnalytics(
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

    lastSearchIdRef.current = searchId;

    // Keyed by the resolved SteamID64 (canonical), with `value` (whatever
    // the user typed) stored as an alias pointing at it — see homeCache.ts.
    setCachedSearch(value, newTargetInfoJson.profileInfo.steamID, {
      targetInfoJson: newTargetInfoJson,
      closeFriendsJson: closeFriends,
      possibleLocationJson: possibleLocation,
      searchId,
    });
  };

  useEffect(() => {
    if (!urlPlayer) {
      return;
    }
    handleGetInfoClick(urlPlayer);
  }, [urlPlayer]);

  const onChangeTarget = (value: string) => {
    targetValue.current = value;
  };

  const hasNoDataYet = !targetInfoJson && !isLoading.myCard;

  return {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    getLocationDetails,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    getCheaterProbability,
    updateQueryParam,
    showSupportMe,
    onCloseSupportMe,
  };
};

export default useHome;
