import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import LocationCard from '@/app/components/LocationCard';
import LocationCardSkeleton from '@/app/components/LocationCard/LocationCardSkeleton';
import { useTranslations } from 'next-intl';
import React from 'react';

type LocationSectionProps = {
  possibleLocationJson: locationDataIWant[] | undefined;
  targetInfoJson: targetInfoJsonType;
  isLoading: boolean;
};

function LocationSection({
  possibleLocationJson,
  targetInfoJson,
  isLoading,
}: LocationSectionProps) {
  const translator = useTranslations('Index');

  if (!possibleLocationJson && !isLoading) {
    return null;
  }

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
        <LocationCardSkeleton />
      )}
    </div>
  );
}

export default LocationSection;
