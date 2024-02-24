'use client';
import axios from 'axios';
import Image from 'next/image';
import { useRef, useState } from 'react';
import { UserSummary } from 'steamapi';
import listOfLocation from '../../location';

type closeFriendsDataIWant = {
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

export default function Home() {
  const targetValue = useRef<string | null>();
  const [closeFriendsJson, setCloseFriendsJson] = useState<
    closeFriendsDataIWant[] | undefined
  >();
  const [possibleLocationJson, setPossibleLocationJson] = useState<
    locationDataIWant[] | undefined
  >();

  const sortCitiesByScore = (listOfCities: any) => {
    return Object.entries(listOfCities)
      .sort((a, b) => b[1] - a[1])
      .reduce((obj, [key, value]) => {
        obj[key] = value;
        return obj;
      }, {});
  };

  const getCitiesNames = (citiesScored: any) => {
    return Object.entries(citiesScored).map(([key, value]) => {
      const [countryCode, stateCode, cityID] = key.split('/');

      const country = listOfLocation.countries.find(
        (country: any) => country.code === countryCode,
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

    let citiesScored: any = {};
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

    return withProbability;
  };

  const handleGetInfoClick = async (value: string) => {
    setCloseFriendsJson(undefined);
    try {
      const { data } = await axios.post('/api/getCloseFriends', {
        target: value,
      });

      const { closeFriends } = data;

      let totalCountOfFriends = 0;
      closeFriends.forEach((f: closeFriendsDataIWant) => {
        totalCountOfFriends += f.count;
      });

      const rasoableNumberToBeAGoodGuess = 20;

      const closeFriendsWithProbability = closeFriends.map(
        (f: closeFriendsDataIWant) => {
          const probability =
            ((f.count / totalCountOfFriends +
              (f.count > rasoableNumberToBeAGoodGuess
                ? 1
                : f.count / rasoableNumberToBeAGoodGuess)) /
              2) *
            100;

          return {
            friend: f.friend,
            count: f.count,
            probability,
          };
        },
      );

      setCloseFriendsJson(closeFriendsWithProbability);

      const possibleLocation = getPossibleLocation(closeFriends);
      setPossibleLocationJson(possibleLocation);
    } catch (e) {
      console.error(e);
    }
  };

  const onChangeTarget = (value: string) => {
    targetValue.current = value;
  };

  return (
    <div className="h-full w-full min-h-screen bg-slate-200 px-12 py-6">
      <input
        className="w-64 h-8 text-black"
        onChange={({ target }) => onChangeTarget(target.value)}
      />
      <button
        className="w-16 h-8 bg-zinc-700 text-slate-50"
        onClick={() => handleGetInfoClick(targetValue.current ?? '')}
      >
        Get Info
      </button>

      <div className="flex gap-x-16 mt-8 text-black">
        <div>
          <h1 className="text-xl font-bold">Friends IRL:</h1>
          {closeFriendsJson &&
            closeFriendsJson.map((f) => (
              <div className="mt-8" key={f.friend.steamID}>
                <p className="mt-1">nickname: {f.friend.nickname}</p>
                <p>real name: {f.friend.realName}</p>
                <p>probability: {f.probability?.toFixed(2)}%</p>
                <p>
                  url:{' '}
                  <a href={f.friend.url} target="_blank">
                    {f.friend.url}
                  </a>
                </p>
                <p>count: {f.count}</p>
              </div>
            ))}
        </div>
        <div>
          <h1 className="text-xl font-bold">Possible Location Of Target</h1>
          {possibleLocationJson &&
            possibleLocationJson.map((l) => (
              <div
                className="mt-8"
                key={`${l.location.countryName}/${l.location.stateName}/${l.location.cityName}`}
              >
                <p className="mt-1">city: {l.location.cityName}</p>
                <p>state: {l.location.stateName}</p>
                <p>country: {l.location.countryName}</p>
                <p>probability: {l.probability.toFixed(2)}%</p>
                <p>count: {l.count}</p>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
