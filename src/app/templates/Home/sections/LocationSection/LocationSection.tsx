import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import type { FriendsVisibility } from '@/lib/analytics/types';
import LocationCard, {
  hasSelfDeclaredLocation,
} from '@/app/components/LocationCard';
import LocationCardSkeleton from '@/app/components/LocationCard/LocationCardSkeleton';
import SectionTitle from '@/app/templates/Home/sections/SectionTitle';
import { useTranslations } from 'next-intl';
import React from 'react';

type LocationSectionProps = {
  possibleLocationJson: locationDataIWant[] | undefined;
  targetInfoJson: targetInfoJsonType;
  /** When 'private', triangulation had no friends to work with (notice shown). */
  friendsVisibility?: FriendsVisibility;
  /** The target's profile is still being fetched. */
  isLoadingProfile?: boolean;
  /** The location estimate is still being computed. */
  isLoadingLocation?: boolean;
};
function LocationSection({
  possibleLocationJson,
  targetInfoJson,
  friendsVisibility,
  isLoadingProfile = false,
  isLoadingLocation = false,
}: LocationSectionProps) {
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
  // moment content arrived - the biggest single CLS source on the player
  // page. Home.tsx only mounts this section when !hasNoDataYet, so showing
  // the skeleton here can never leak onto the empty home state.
  //
  // The skeleton is shown while the card is still PENDING (the profile or
  // the location estimate is being fetched). Once both requests are done -
  // including the failure path, where an invalid player leaves the loading
  // flags false - the section settles on its real state (the card, the empty
  // state, or nothing), so no skeleton is left spinning forever.
  const cardPending = isLoadingProfile || isLoadingLocation;
  let locationContent: React.ReactNode = null;
  if (possibleLocationJson) {
    locationContent = (
      <>
        {triangulationNotice}
        <LocationCard
          possibleLocations={possibleLocationJson}
          providedLocation={providedLocation}
        />
      </>
    );
  } else if (cardPending) {
    locationContent = (
      // The skeleton is rendered from the very first paint, before the
      // profile is even known, and it reserves the card's final height
      // (the 400px map area included). That makes this section's height
      // constant for the whole life of the page: nothing below it (the
      // friends block, the footer) ever has to move because of it.
      //
      // Gating it on the profile instead (the previous behaviour) made the
      // height depend on WHEN the profile and the location lookup landed:
      // the section grew by ~460px whenever the map area appeared, and that
      // growth pushed the ~6500px friends skeleton block out of the
      // viewport - the single biggest layout shift on the player page.
      //
      // Keyed by the profile currently being shown: LocationCardSkeleton
      // locks its own shape in on first render (see that component) and
      // never recomputes it from later prop updates. Without this key,
      // the SAME skeleton instance could stay mounted across two
      // different players (possibleLocationJson is undefined at the
      // start of every new search too), and would keep showing the
      // PREVIOUS player's locked shape for the new one. The key forces a
      // fresh instance - and a fresh lock - per player.
      <>
        {triangulationNotice}
        <LocationCardSkeleton
          key={targetInfoJson?.profileInfo?.steamID}
          providedLocation={providedLocation}
        />
      </>
    );
  }
  return (
    <div data-testid="location-section">
      <SectionTitle translationKey="userPossibleLocation" />
      {locationContent}
    </div>
  );
}
export default LocationSection;
