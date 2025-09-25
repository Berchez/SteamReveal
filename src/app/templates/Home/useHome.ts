import axios from 'axios';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useTranslations } from 'next-intl';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { useSearchParams, useRouter } from 'next/navigation';
import { cityNameAndScore } from '@/@types/cityNameAndScore';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import { CheaterDataType } from '@/@types/cheaterDataType';
import {
  getLocationDetails,
  getCitiesNames,
  sortCitiesByScore,
} from './homeUtils';

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

const useHome = () => {
  const router = useRouter();
  const searchParams = useSearchParams();

  const { showSponsorMe, handleShowSponsorMe, onCloseSponsorMe } =
    useSponsorMe();

  const updateQueryParam = (key: string, value: string) => {
    const currentParams = new URLSearchParams(searchParams.toString());
    currentParams.set(key, value);
    router.replace(`?${currentParams.toString()}`);
  };

  const targetValue = useRef<string | null>();
  const translator = useTranslations('ServerMessages');

  const [closeFriendsJson, setCloseFriendsJson] = useState<
    closeFriendsDataIWant[] | undefined
  >();

  const [possibleLocationJson, setPossibleLocationJson] = useState<
    locationDataIWant[] | undefined
  >();

  const [isLoading, setIsLoading] = useState<{
    myCard: boolean;
    friendsCards: boolean;
  }>({ myCard: false, friendsCards: false });

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

      setTargetInfoJson({
        profileInfo: targetInfo,
        targetLocationInfo: locationInfo,
      });

      updateQueryParam('player', targetInfo.steamID);
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
  };

  const getCheaterProbability = async (
    target: string,
    closeFriends: closeFriendsDataIWant[],
  ) => {
    try {
      const response = await axios.post('/api/getCheaterProbability', {
        target,
        closeFriends,
      });

      return response?.data;
    } catch (e) {
      toast.error('Failed to calculate cheater probability');
      console.error('getCheaterProbability error:', e);
      return null;
    }
  };

  const handleGetInfoClick = async (value: string, key: string) => {
    if (key !== 'Enter') {
      return;
    }

    handleShowSponsorMe();

    resetJsons();

    await getUserInfoJson(value);
    const closeFriends = await getCloseFriendsJson(value);
    getPossibleLocation(closeFriends);

    const cheaterProbability = await getCheaterProbability(value, closeFriends);
    console.log('probability', cheaterProbability);
    setCheaterData(cheaterProbability);
  };

  useEffect(() => {
    if (!urlPlayer) {
      return;
    }
    handleGetInfoClick(urlPlayer, 'Enter');
  }, [urlPlayer, searchParams]);

  const onChangeTarget = (value: string) => {
    targetValue.current = value;
  };

  const hasNoDataYet = !targetInfoJson && !isLoading.myCard;

  return {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    getLocationDetails,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
  };
};

export default useHome;
