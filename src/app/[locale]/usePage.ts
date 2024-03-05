import axios from 'axios';
import { useRef, useState } from 'react';
import { UserSummary } from 'steamapi';
import listOfLocation from '../../../location';

export type closeFriendsDataIWant = {
  friend: UserSummary;
  count: number;
  probability?: number;
};

type locationDataIWant = {
  location: {
    cityName: string;
    stateName: string;
    countryName: string;
  };
  count: number;
  probability: number;
};

type cityNameAndScore = { [key: string]: number };

const usePage = () => {
  const targetValue = useRef<string | null>();
  const [closeFriendsJson, setCloseFriendsJson] = useState<
    closeFriendsDataIWant[] | undefined
  >();
  const [possibleLocationJson, setPossibleLocationJson] = useState<
    locationDataIWant[] | undefined
  >();
  const [targetInfoJson, setTargetInfoJson] = useState<UserSummary>();

  const sortCitiesByScore = (listOfCities: cityNameAndScore) => {
    return Object.entries(listOfCities)
      .sort((a, b) => {
        return b[1] - a[1];
      })
      .reduce((obj: cityNameAndScore, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
  };

  const getCitiesNames = (citiesScored: cityNameAndScore) => {
    return Object.entries(citiesScored).map(([key, value]) => {
      const [countryCode, stateCode, cityID] = key.split('/');

      const country = listOfLocation.countries.find(
        (country) => country.code === countryCode,
      );
      if (!country) throw Error('Country not found');

      const state = country?.states?.find((state) => state.code === stateCode);
      if (!state) throw Error('State not found');

      const city = state?.cities?.find((city) => city.id === parseInt(cityID));
      if (!city) throw Error('City not found');

      return {
        location: {
          cityName: city.name,
          stateName: state.name,
          countryName: country.name,
        },
        count: value as number,
      };
    });
  };

  const getPossibleLocation = (
    closeFriendsOfTheTarget: closeFriendsDataIWant[],
  ) => {
    const closeFriendsWithCities = closeFriendsOfTheTarget.filter(
      (f: closeFriendsDataIWant) => f.friend.cityID !== undefined,
    );

    let citiesScored: cityNameAndScore = {};
    closeFriendsWithCities.map((f: closeFriendsDataIWant) => {
      const cityKey = `${f.friend.countryCode}/${f.friend.stateCode}/${f.friend.cityID}`;

      citiesScored[cityKey] = citiesScored[cityKey]
        ? citiesScored[cityKey] * f.count
        : f.count;
    });

    citiesScored = sortCitiesByScore(citiesScored);

    const citiesScoredWithNames = getCitiesNames(citiesScored);

    let totalCountOfScores = 0;
    citiesScoredWithNames.forEach((c) => {
      totalCountOfScores += c.count;
    });

    const rasoableNumberToBeAGoodGuess = 100;

    const withProbability = citiesScoredWithNames.map((c) => {
      const probability =
        (((c.count / totalCountOfScores) * 2 +
          (c.count > rasoableNumberToBeAGoodGuess
            ? 1
            : c.count / rasoableNumberToBeAGoodGuess)) /
          3) *
        100;

      return {
        location: c.location,
        count: c.count,
        probability,
      };
    });

    setPossibleLocationJson(withProbability);

    return withProbability;
  };

  const getUserInfoJson = async (value: string) => {
    try {
      const { data } = await axios.post('/api/getUserInfo', {
        target: value,
      });

      const { targetInfo } = data;

      setTargetInfoJson(targetInfo);
    } catch (e) {
      console.error(e);
    }
  };

  const getCloseFriendsJson = async (value: string) => {
    try {
      const { data } = await axios.post('/api/getCloseFriends', {
        target: value,
      });

      const { closeFriends } = data;

      let totalCountOf5ClosestFriends = 0;
      for (let i = 0; i < 5; i++) {
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
      console.error(e);
    }
  };

  const resetJsons = () => {
    setCloseFriendsJson(undefined);
    setPossibleLocationJson(undefined);
    setTargetInfoJson(undefined);
  };

  const handleGetInfoClick = async (value: string, key: string) => {
    if (key !== 'Enter') {
      return;
    }

    resetJsons();

    getUserInfoJson(value);
    const closeFriends = await getCloseFriendsJson(value);
    getPossibleLocation(closeFriends);
  };

  const onChangeTarget = (value: string) => {
    targetValue.current = value;
  };

  return {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
  };
};

export default usePage;
