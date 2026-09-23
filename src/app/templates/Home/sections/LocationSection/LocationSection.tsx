import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import type { FriendsVisibility } from '@/lib/analytics/types';
import LocationCard, {
  hasSelfDeclaredLocation,
} from '@/app/components/LocationCard';
import LocationCardSkeleton from '@/app/components/LocationCard/LocationCardSkeleton';
import { useTranslations } from 'next-intl';
import React from 'react';

type LocationSectionProps = {
  possibleLocationJson: locationDataIWant[] | undefined;
  targetInfoJson: targetInfoJsonType;
  /** When 'private', triangulation had no friends to work with (notice shown). */
  friendsVisibility?: FriendsVisibility;
};
function LocationSection({
  possibleLocationJson,
  targetInfoJson,
  friendsVisibility,
}: LocationSectionProps) {
  const translator = useTranslations('Index');
  const locationCardTranslator = useTranslations('LocationCard');
  const providedLocation = {
    cityName: targetInfoJson?.targetLocationInfo?.city?.name,
    stateName: targetInfoJson?.targetLocationInfo?.state?.name,
    countryName: targetInfoJson?.targetLocationInfo?.country?.name,
    countryCode: targetInfoJson?.targetLocationInfo?.country?.code,
  };
  // Private-list notice, rendered IDENTICALLY in both branches below (same
  // element, same position, same string): friendsVisibility is already
  // known while the location is still resolving, so showing it over the
  // skeleton too means the skeleton→card swap adds/removes nothing — no
  // layout shift on that transition, just the pre-existing card swap.
  // Shown ONLY when the profile declared something: with no self-declared
  // location the card renders the no-estimate empty state, and a notice
  // claiming "showing only the self-declared location" would be wrong.
  const triangulationNotice =
    friendsVisibility === 'private' &&
    hasSelfDeclaredLocation(providedLocation) ? (
      <p
        data-testid="location-triangulation-notice"
        className="mt-4 text-sm text-gray-400"
      >
        {locationCardTranslator('triangulationUnavailable')}
      </p>
    ) : null;
  // Render the skeleton as long as the location hasn't resolved. Rendering
  // `null` while `!data && !isLoading` (the window where the data fetch
  // hasn't kicked off yet / is between resets) collapsed this section to
  // zero height on first paint, then banked a full-section layout shift the
  // moment content arrived — the biggest single CLS source on the player
  // page. Home.tsx only mounts this section when !hasNoDataYet, so showing
  // the skeleton here can never leak onto the empty home state.
  return (
    <div data-testid="location-section">
      <h1 className="text-2xl font-bold text-gray-100">
        {translator('userPossibleLocation')}
      </h1>
      {possibleLocationJson ? (
        <>
          {triangulationNotice}
          <LocationCard
            possibleLocations={possibleLocationJson}
            providedLocation={providedLocation}
          />
        </>
      ) : (
        <>
          {triangulationNotice}
          {/* Keyed by the profile currently being shown: LocationCardSkeleton
          locks its own shape in on first render (see that component) and
          never recomputes it from later prop updates. Without this key,
          the SAME skeleton instance could stay mounted across two
          different players (possibleLocationJson is undefined at the
          start of every new search too), and would keep showing the
          PREVIOUS player's locked shape for the new one. The key forces a
          fresh instance — and a fresh lock — per player. */}
          <LocationCardSkeleton
          key={targetInfoJson?.profileInfo?.steamID}
          providedLocation={providedLocation}
        />
        </>
      )}
    </div>
  );
}
export default LocationSection;
