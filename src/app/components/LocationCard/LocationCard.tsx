import { locationDataIWant } from '@/@types/locationDataIWant';
import { useTranslations } from 'next-intl';
import React from 'react';
import LocationMap from './LocationMap';

export type ProvidedLocation = {
  cityName?: string;
  stateName?: string;
  countryName?: string;
  countryCode?: string;
};

/**
 * Whether the profile declared any location itself. ANY field counts —
 * profiles often declare only a country (e.g. countryCode "CN" with no
 * state/city). Shared with LocationSection (which gates the triangulation
 * notice on it) so the rule can never drift between the two.
 */
export const hasSelfDeclaredLocation = (
  providedLocation: ProvidedLocation | undefined,
): boolean =>
  Boolean(
    providedLocation?.cityName ||
      providedLocation?.stateName ||
      providedLocation?.countryName ||
      providedLocation?.countryCode,
  );

function LocationCard({
  providedLocation,
  possibleLocations,
}: {
  providedLocation: ProvidedLocation;
  possibleLocations?: locationDataIWant[];
}) {
  const translator = useTranslations('LocationCard');

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  // Zero-count / zero-probability candidates carry no triangulation evidence.
  // computeCityScores no longer emits them (count-0 friends are skipped), but
  // cached/legacy data can still contain them — never render a pointless row.
  const visibleLocations = (possibleLocations ?? []).filter(
    (l) => l.count > 0 && l.probability > 0,
  );

  // Whether the profile itself provided a location (rendered as the
  // "Provided by user" block below). The estimate only covers friend-based
  // triangulation; when neither exists there is nothing to show, so the
  // component returns the gray-glass empty state below instead of the
  // purple triangulation card.
  const hasProvidedLocation = hasSelfDeclaredLocation(providedLocation);
  const hasEstimate = visibleLocations.length > 0;

  if (!hasEstimate && !hasProvidedLocation) {
    return (
      <div
        data-testid="location-empty-state"
        className="mt-8 rounded-xl border border-gray-700 bg-gray-800/60 p-6 text-left"
      >
        <p className="text-sm text-gray-300">
          {translator('noLocationEstimate')}
        </p>
      </div>
    );
  }
  // The header only needs bottom margin when content follows it —
  // triangulation rows or the map (rendered for city-level declarations).
  // A lone "Provided by user" block (e.g. country-only) must not carry a
  // dangling mb-3 into the card's bottom padding.
  const hasContentBelow = hasEstimate || Boolean(providedLocation.cityName);

  const topLocation = visibleLocations[0];
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
      {hasProvidedLocation && (
        <div
          className={`flex gap-x-5 ${hasContentBelow ? 'mb-3' : ''} font-semibold text-lg flex-wrap`}
        >
          {translator('providedByUser')}
          <div className="flex items-center gap-x-2 flex-wrap">
            {providedLocation.countryCode && (
              <img
                src={`https://flagcdn.com/w20/${providedLocation.countryCode.toLowerCase()}.png`}
                className="w-max h-max"
                alt={`${providedLocation.countryCode}'s flag`}
                width={20}
                height={14}
              />
            )}
            {providedLocation.cityName && <p>{providedLocation.cityName},</p>}
            {providedLocation.stateName && <p>{providedLocation.stateName},</p>}
            {providedLocation.countryName && (
              <p>{providedLocation.countryName}</p>
            )}
          </div>
        </div>
      )}

      {visibleLocations.map((l, index) => {
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
