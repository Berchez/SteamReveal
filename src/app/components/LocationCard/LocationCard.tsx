import { locationDataIWant } from '@/@types/locationDataIWant';
import { useTranslations } from 'next-intl';
import React from 'react';
import LocationMap from './LocationMap';

function LocationCard({
  providedLocation,
  possibleLocations,
}: {
  providedLocation: {
    cityName?: string;
    stateName?: string;
    countryName?: string;
    countryCode?: string;
  };
  possibleLocations?: locationDataIWant[];
}) {
  const translator = useTranslations('LocationCard');

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  const topLocation = possibleLocations?.[0];
  const showMap =
    topLocation && topLocation.probability >= 60 && topLocation.count >= 30;

  const mapQuery = topLocation
    ? `${topLocation.location.cityName || ''}, ${
        topLocation.location.stateName || ''
      }, ${topLocation.location.countryName || ''}`
    : `${providedLocation.cityName || ''}, ${
        providedLocation.stateName || ''
      }, ${providedLocation.countryName || ''}`;

  return (
    <div className={`mt-8 text-white py-4 px-8 ${glassmorphism}`}>
      {providedLocation.stateName && providedLocation.countryCode && (
        <div className="flex gap-x-5 mb-3 font-semibold text-lg flex-wrap">
          {translator('providedByUser')}
          <div className="flex items-center gap-x-2 flex-wrap">
            <img
              src={`https://flagcdn.com/w20/${providedLocation.countryCode.toLowerCase()}.png`}
              className="w-max h-max"
              alt={`${providedLocation.countryCode}'s flag`}
              width={20}
              height={14}
            />
            {providedLocation.cityName && <p>{providedLocation.cityName},</p>}
            {providedLocation.stateName && <p>{providedLocation.stateName},</p>}
            {providedLocation.countryName && (
              <p>{providedLocation.countryName}</p>
            )}
          </div>
        </div>
      )}

      {possibleLocations &&
        possibleLocations.map((l, index) => {
          const { cityName, stateName, countryName, countryCode } = l.location;
          const isFirst = index === 0;

          return (
            <React.Fragment
              key={`${l.location.countryName}/${l.location.stateName}/${l.location.cityName}`}
            >
              <div className="flex md:items-center md:justify-between md:flex-row flex-col mb-2">
                <div className="flex items-center gap-x-2">
                  {countryCode && (
                    <img
                      src={`https://flagcdn.com/w20/${countryCode.toLowerCase()}.png`}
                      className="w-max h-max"
                      alt={`${countryCode}'s flag`}
                      width={20}
                      height={14}
                    />
                  )}
                  {cityName && `${cityName}, `}
                  {stateName && `${stateName}, `}
                  {countryName && `${countryName}`}
                </div>
                <div className="flex gap-x-1">
                  {l.probability.toFixed(2)}%
                  <p className="text-xs self-end justify-end">({l.count})</p>
                </div>
              </div>

              {isFirst && showMap && <LocationMap query={mapQuery} isTop />}
            </React.Fragment>
          );
        })}

      {!showMap && providedLocation.cityName && (
        <LocationMap query={mapQuery} />
      )}
    </div>
  );
}

export default LocationCard;
