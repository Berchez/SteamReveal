import React, { useState } from 'react';
import { hasSelfDeclaredLocation } from './LocationCard';

// Render the number of skeleton rows that matches the typical final state.
// Analytics data shows the mean number of candidate-location rows per
// profile is ~3 (median sits between 3 and 4, skewing mean-3), and the
// analytics payload itself stores at most 3 location guesses (client
// `.slice(0, 3)`). A 3-row skeleton keeps the swap height-neutral for the
// average profile, so the location card doesn't visibly grow when it
// resolves.
//
// The keys are INDEX-based on purpose: `crypto.randomUUID()` produced a
// different key set on the server and on the client, so React threw the
// server-rendered skeleton away and rebuilt it on hydration - the card
// collapsed and grew again, which is a layout shift of its own.
const skeletonKeys = ['location-skeleton-0', 'location-skeleton-1', 'location-skeleton-2'];
type ProvidedLocation = {
  cityName?: string;
  stateName?: string;
  countryName?: string;
  countryCode?: string;
};

function LocationCardSkeleton({
  providedLocation,
}: {
  providedLocation?: ProvidedLocation;
}) {
  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';
  // targetInfoJson USUALLY resolves fully before this skeleton ever gets a
  // chance to render (see useHomeSearch.ts's non-seeded path), so most of
  // the time providedLocation is already final on first render.
  //
  // EXCEPTION — the seeded (server-rendered profile) path: targetLocationInfo
  // starts as `{}` and is enriched asynchronously a moment later, while this
  // exact skeleton instance is still mounted. If the shape were recomputed
  // from live props on every render, that later enrichment would add a
  // "provided by user" line to an already-visible skeleton: a smaller
  // shift, but the same class of bug.
  //
  // The 400px map area is a DIFFERENT case and is deliberately NOT
  // conditional: it is always reserved, because it is the single biggest
  // block in this card and the final card only renders it for some
  // profiles. A conditional placeholder meant the section grew by ~460px
  // whenever the location lookup (a dynamically imported country dataset,
  // so it lands whenever the network lets it) told us the profile has a
  // city. That growth slid the whole friends block below it out of the
  // viewport and banked the largest layout shift on the player page.
  // Reserving the space unconditionally pins the section's height from the
  // first paint, whatever the profile turns out to be.
  //
  // Locking the shape via a lazy useState initializer (runs once, on this
  // instance's first render only) fixes it — paired with LocationSection
  // giving this component a `key` tied to the current player, so a new
  // player always gets a brand-new instance/lock instead of inheriting the
  // previous player's shape.
  //
  // NOTE: the lock snapshots the WHOLE providedLocation object, not just the
  // two derived booleans. The displayed fields (city/state/country names)
  // must come from the same frozen snapshot — otherwise a field arriving
  // late (e.g. cityName resolving after stateName+countryCode were already
  // present) would pop a new paragraph into the already-visible "provided by
  // user" line: a smaller shift, but the same class of bug.
  const [{ hasProvidedLocation, lockedProvided }] = useState(
    () => ({
      // Same rule as LocationCard (shared helper): a country-only profile
      // must lock the provided shape here too, or the skeleton and the
      // final card would disagree (self-inflicted layout shift).
      hasProvidedLocation: hasSelfDeclaredLocation(providedLocation),
      lockedProvided: { ...(providedLocation ?? {}) },
    }),
  );
  return (
    <div className={`mt-8 text-white py-4 px-8 ${glassmorphism}`}>
      {hasProvidedLocation && (
        <div
          className="flex gap-x-5 mb-3 font-semibold text-lg flex-wrap"
          data-testid="location-skeleton-provided"
        >
          Provided by user
          <div className="flex items-center gap-x-2 flex-wrap">
            {lockedProvided.countryCode && (
              <img
                src={`https://flagcdn.com/w20/${lockedProvided.countryCode.toLowerCase()}.png`}
                className="w-max h-max"
                alt={`${lockedProvided.countryCode}'s flag`}
                width={20}
                height={14}
              />
            )}
            {lockedProvided.cityName && <p>{lockedProvided.cityName},</p>}
            {lockedProvided.stateName && <p>{lockedProvided.stateName},</p>}
            {lockedProvided.countryName && <p>{lockedProvided.countryName}</p>}
          </div>
        </div>
      )}
      <div className="flex flex-col">
        {skeletonKeys.map((skeletonKey) => (
          <div
            className="flex md:items-center md:justify-between md:flex-row flex-col mb-2 animate-pulse"
            key={skeletonKey}
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
      <div
        className="my-6 pt-6 border-t border-gray-100/20 animate-pulse"
        data-testid="location-skeleton-map"
      >
        <div className="w-full h-[400px] rounded-lg bg-gray-500/40" />
      </div>
    </div>
  );
}
export default LocationCardSkeleton;
