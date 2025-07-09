import { cityNameAndScore } from '@/@types/cityNameAndScore';
import { LocationInfoType } from '@/@types/targetInfoJsonType';

export const getLocationDetails = async (
  countryCode?: string,
  stateCode?: string,
  cityID?: string,
): Promise<LocationInfoType> => {
  const { default: listOfLocation } = await import('../../../../location');

  const country = listOfLocation.countries.find((c) => c.code === countryCode);
  const state = country?.states?.find((s) => s.code === stateCode);
  const city = state?.cities?.find(
    (c) => cityID && c.id === parseInt(cityID, 10),
  );

  return { country, state, city };
};

export const sortCitiesByScore = (listOfCities: cityNameAndScore) =>
  Object.entries(listOfCities)
    .sort((a, b) => b[1] - a[1])
    .reduce(
      (acc: cityNameAndScore, [key, value]) => ({ ...acc, [key]: value }),
      {},
    );

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
