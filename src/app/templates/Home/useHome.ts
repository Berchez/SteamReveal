import axios from 'axios';
import { useRef, useState } from 'react';
import { toast } from 'react-toastify';
import { useTranslations } from 'next-intl';
import { locationDataIWant } from '@/@types/locationDataIWant';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import targetInfoJsonType, {
  LocationInfoType,
} from '@/@types/targetInfoJsonType';

export const getLocationDetails = async (
  countryCode?: string,
  stateCode?: string,
  cityID?: string,
): Promise<LocationInfoType> => {
  try {
    const { default: listOfLocation } = await import('../../../../location');

    const country = listOfLocation.countries.find(
      (c) => c.code === countryCode,
    );
    const state = country?.states?.find((s) => s.code === stateCode);
    const city = state?.cities?.find(
      (c) => cityID && c.id === parseInt(cityID, 10),
    );

    return { country, state, city };
  } catch (error) {
    console.error('Failed to load location data:', error);
    throw new Error('Unable to retrieve location details');
  }
};

type cityNameAndScore = { [key: string]: number };

export const useHome = () => {
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

  const [showSponsorMe, setShowSponsorMe] = useState(false);

  const onCloseSponsorMe = (visitCountToSet = 0) => {
    localStorage.setItem('visitCount', visitCountToSet.toString());
    setShowSponsorMe(false);
  };

  const [targetInfoJson, setTargetInfoJson] = useState<targetInfoJsonType>();

  const sortCitiesByScore = (listOfCities: cityNameAndScore) =>
    Object.entries(listOfCities)
      .sort((a, b) => b[1] - a[1])
      .reduce(
        (acc: cityNameAndScore, [key, value]) => ({ ...acc, [key]: value }),
        {},
      );

  const getCitiesNames = (citiesScored: cityNameAndScore) =>
    Object.entries(citiesScored).map(async ([key, value]) => {
      const [countryCode, stateCode, cityID] = key.split('/');

      const { city, state, country } = await getLocationDetails(
        countryCode,
        stateCode,
        cityID,
      );

      return {
        location: {
          cityName: city?.name,
          stateName: state?.name,
          countryName: country?.name,
          countryCode: country?.code,
        },
        count: value as number,
      };
    });

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

    const citiesScoredWithNames = await Promise.all(
      getCitiesNames(citiesScored),
    );

    let totalCountOfScores = 0;
    citiesScoredWithNames.forEach((c) => {
      totalCountOfScores += c.count;
    });

    const rasoableNumberToBeAGoodGuess = 100;

    const withProbability = citiesScoredWithNames.map((c) => {
      const totalCountMethod =
        totalCountOfScores === 0 ? 0 : c.count / totalCountOfScores;

      const constantMethod =
        c.count > rasoableNumberToBeAGoodGuess
          ? 1
          : c.count / rasoableNumberToBeAGoodGuess;

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
      const walter = await axios.post('/api/getUserInfo', {
        target: value,
      });

      console.log('walter awa', walter);

      const { targetInfo } = walter.data;

      const locationInfo = await getLocationDetails(
        targetInfo.countryCode,
        targetInfo.stateCode,
        targetInfo.cityID,
      );

      setTargetInfoJson({
        profileInfo: targetInfo,
        targetLocationInfo: locationInfo,
      });
    } catch (e) {
      toast.warn(translator('invalidPlayer'));
      console.error(e);
      throw e;
    } finally {
      setIsLoading((prev) => ({ ...prev, myCard: false }));
    }
  };

  const getCloseFriendsJson = async (value: string) => {
    try {
      setIsLoading((prev) => ({ ...prev, friendsCards: true }));

      const response = await axios.post('/api/getCloseFriends', {
        target: value,
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
      const rasoableNumberToBeAGoodGuess = 50;

      const closeFriendsWithProbability = closeFriends.map(
        (f: closeFriendsDataIWant) => {
          const meanProbabilityMethod =
            f.count / (meanOf5ClosestFriendsCount * 1.5) > 1
              ? 1
              : f.count / (meanOf5ClosestFriendsCount * 1.5);

          const biggestCountMethod = f.count / biggestCountValue;

          const constantMethod =
            f.count / rasoableNumberToBeAGoodGuess > 1
              ? 1
              : f.count / rasoableNumberToBeAGoodGuess;

          const probabilityFloat =
            (meanProbabilityMethod * 2 +
              biggestCountMethod * 2 +
              constantMethod) /
            5;

          const probabilityPercentage = probabilityFloat * 100;

          return {
            friend: f.friend,
            count: f.count,
            probability: probabilityPercentage,
          };
        },
      );

      setCloseFriendsJson(closeFriendsWithProbability);

      return closeFriendsWithProbability;
    } catch (e) {
      toast.warn(translator('friendsNotPublic'));
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
  };

  const handleShowSponsorMe = () => {
    const visitCount = localStorage.getItem('visitCount');
    const count = visitCount ? parseInt(visitCount, 10) : 0;

    if (count >= 2) {
      setShowSponsorMe(true);
    }

    localStorage.setItem('visitCount', (count + 1).toString());
  };

  const handleGetInfoClick = async (value: string, key: string) => {
    if (key !== 'Enter') {
      return;
    }

    handleShowSponsorMe();

    resetJsons();

    await getUserInfoJson(value).then((a) => console.log('walter', a));
    const closeFriends = await getCloseFriendsJson(value);
    getPossibleLocation(closeFriends);
  };

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
  };
};
