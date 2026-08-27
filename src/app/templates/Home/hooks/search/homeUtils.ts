import { cityNameAndScore } from '@/@types/cityNameAndScore';
import { LocationInfoType } from '@/@types/targetInfoJsonType';

interface CountryData {
  code: string;
  name: string;
  states: Record<
    string,
    {
      code: string;
      name: string;
      cities: Record<string, { id: number; name: string }>;
    }
  >;
}

const countryCache: Record<string, CountryData> = {};

export const getLocationDetails = async (
  countryCode?: string,
  stateCode?: string,
  cityID?: string,
): Promise<LocationInfoType> => {
  if (!countryCode) {
    return { country: undefined, state: undefined, city: undefined };
  }

  const code = countryCode.toUpperCase();

  try {
    if (!countryCache[code]) {
      const data = await import(`../../../lib/locations/data/${code}.json`);
      countryCache[code] = data.default || data;
    }

    const countryData = countryCache[code];
    const stateData = stateCode ? countryData.states[stateCode] : undefined;
    const cityData = stateData && cityID ? stateData.cities[cityID] : undefined;

    return {
      country: countryData
        ? { code: countryData.code, name: countryData.name }
        : undefined,
      state: stateData
        ? { code: stateData.code, name: stateData.name }
        : undefined,
      city: cityData,
    };
  } catch (error) {
    return { country: undefined, state: undefined, city: undefined };
  }
};

export const sortCitiesByScore = (listOfCities: cityNameAndScore) => {
  const sortedEntries = Object.entries(listOfCities).sort(
    (a, b) => b[1] - a[1],
  );

  const acc: cityNameAndScore = {};
  sortedEntries.forEach(([key, value]) => {
    acc[key] = value;
  });

  return acc;
};

export const getCitiesNames = async (
  citiesScored: cityNameAndScore,
): Promise<
  {
    location: {
      cityName?: string;
      stateName?: string;
      countryName?: string;
      countryCode?: string;
    };
    count: number;
  }[]
> => {
  const entries = await Promise.all(
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
        count: value,
      };
    }),
  );

  return entries;
};
