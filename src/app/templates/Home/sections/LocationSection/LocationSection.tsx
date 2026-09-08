import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import LocationCard from '@/app/components/LocationCard';
import LocationCardSkeleton from '@/app/components/LocationCard/LocationCardSkeleton';
import { useTranslations } from 'next-intl';
import React from 'react';

type LocationSectionProps = {
  possibleLocationJson: locationDataIWant[] | undefined;
  targetInfoJson: targetInfoJsonType;
};
function LocationSection({
  possibleLocationJson,
  targetInfoJson,
}: LocationSectionProps) {
  const translator = useTranslations('Index');
  // Render the skeleton as long as the location hasn't resolved. Rendering
  // `null` while `!data && !isLoading` (the window where the data fetch
  // hasn't kicked off yet / is between resets) collapsed this section to
  // zero height on first paint, then banked a full-section layout shift the
  // moment content arrived — the biggest single CLS source on the player
  // page. Home.tsx only mounts this section when !hasNoDataYet, so showing
  // the skeleton here can never leak onto the empty home state.
  return (
    <div>
      <h1 className="text-2xl font-bold text-gray-100">
        {translator('userPossibleLocation')}
      </h1>
      {possibleLocationJson ? (
        <LocationCard
          possibleLocations={possibleLocationJson}
          providedLocation={{
            cityName: targetInfoJson?.targetLocationInfo?.city?.name,
            stateName: targetInfoJson?.targetLocationInfo?.state?.name,
            countryName: targetInfoJson?.targetLocationInfo?.country?.name,
            countryCode: targetInfoJson?.targetLocationInfo?.country?.code,
          }}
        />
      ) : (
        // Keyed by the profile currently being shown: LocationCardSkeleton
        // locks its own shape in on first render (see that component) and
        // never recomputes it from later prop updates. Without this key,
        // the SAME skeleton instance could stay mounted across two
        // different players (possibleLocationJson is undefined at the
        // start of every new search too), and would keep showing the
        // PREVIOUS player's locked shape for the new one. The key forces a
        // fresh instance — and a fresh lock — per player.
        <LocationCardSkeleton
          key={targetInfoJson?.profileInfo?.steamID}
          providedLocation={{
            cityName: targetInfoJson?.targetLocationInfo?.city?.name,
            stateName: targetInfoJson?.targetLocationInfo?.state?.name,
            countryName: targetInfoJson?.targetLocationInfo?.country?.name,
            countryCode: targetInfoJson?.targetLocationInfo?.country?.code,
          }}
        />
      )}
    </div>
  );
}
export default LocationSection;
