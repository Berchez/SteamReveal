import React from 'react';

const skeletonUUIDs = Array.from({ length: 3 }, () => crypto.randomUUID());

function LocationCardSkeleton({
  providedLocation,
}: {
  providedLocation?: {
    cityName?: string;
    stateName?: string;
    countryName?: string;
    countryCode?: string;
  };
}) {
  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  // targetInfoJson resolves before possibleLocationJson (see useHomeSearch.ts),
  // so this data is already known by the time this skeleton renders — no
  // need to guess or placeholder it, render it for real.
  const hasProvidedLocation =
    providedLocation?.stateName && providedLocation?.countryCode;

  // Whether a map renders at all only depends on `cityName` (either as the
  // showMap=true top map, or the showMap=false fallback map) OR on
  // possibleLocations data we don't have yet. cityName is already known
  // here, so if it's set, a map is guaranteed to render somewhere in the
  // card — reserve its height regardless of which of the two positions it
  // ends up in (total card height is the same either way, only internal
  // ordering changes, which doesn't cause CLS).
  const willShowMap = Boolean(providedLocation?.cityName);

  return (
    <div className={`mt-8 text-white py-4 px-8 ${glassmorphism}`}>
      {hasProvidedLocation && (
        <div className="flex gap-x-5 mb-3 font-semibold text-lg flex-wrap">
          Provided by user
          <div className="flex items-center gap-x-2 flex-wrap">
            <img
              src={`https://flagcdn.com/w20/${providedLocation!.countryCode!.toLowerCase()}.png`}
              className="w-max h-max"
              alt={`${providedLocation!.countryCode}'s flag`}
              width={20}
              height={14}
            />
            {providedLocation!.cityName && <p>{providedLocation!.cityName},</p>}
            {providedLocation!.stateName && (
              <p>{providedLocation!.stateName},</p>
            )}
            {providedLocation!.countryName && (
              <p>{providedLocation!.countryName}</p>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-col">
        {skeletonUUIDs.map((uuid) => (
          <div
            className="flex md:items-center md:justify-between md:flex-row flex-col mb-2 animate-pulse"
            key={uuid}
          >
            <div className="flex items-center gap-x-2">
              <div className="w-6 h-4 bg-gray-500" />
              <div className="w-80 h-4 bg-gray-500 rounded-md" />
            </div>
            <div className="flex gap-x-1 mt-2">
              <div className="w-12 h-4 bg-gray-500 rounded-md" />
              <div className="w-6 h-3 mt-2 bg-gray-500 rounded-md" />
            </div>
          </div>
        ))}
      </div>

      {willShowMap && (
        <div className="my-6 pt-6 border-t border-gray-100/20 animate-pulse">
          <div className="w-full h-[400px] rounded-lg bg-gray-500/40" />
        </div>
      )}
    </div>
  );
}

export default LocationCardSkeleton;
