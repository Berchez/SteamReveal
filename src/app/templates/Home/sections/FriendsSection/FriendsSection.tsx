'use client';

import React from 'react';
import { useTranslations } from 'next-intl';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import type { FriendsVisibility } from '@/lib/analytics/types';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import { useLikelyLoggedIn } from '@/app/templates/Home/context';
import { useGcServiceStatus } from '@/app/templates/Home/shared/analytics/gcServiceStatus';
import SectionTitle from '@/app/templates/Home/sections/SectionTitle';
import GamersClubBanner from './GamersClubBanner';
import { closeFriendsDataIWant } from '../../../../../@types/closeFriendsDataIWant';

type FriendsSectionProps = {
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  /**
   * How the list resolved. Undefined while loading AND when the friends
   * request failed (unknown — renders no empty-state claim either way).
   * Drives the empty-state copy.
   */
  friendsVisibility?: FriendsVisibility;
  /**
   * True once the target's profile is known (the client resolved it). The
   * skeleton pool is a ~6500px block, and the profile is only known
   * client-side (the server-rendered player page has no session data), so
   * this keeps that block out of the server-rendered HTML: the first paint
   * stays small instead of shipping twenty skeleton cards' worth of markup.
   * The pool appears right after the profile seed, by which point the
   * location section above already reserves its final height, so nothing
   * that is on screen has to move when it shows up.
   */
  profileReady?: boolean;
};

// Skeleton pool matches the product cap for this list: the route trims the
// computed list to MAX_CLOSE_FRIENDS (GET /api/getCloseFriends slices to
// `slice(0, MAX_CLOSE_FRIENDS)`), and real analytics data shows the median
// profile renders ~18-20 friend cards. A pool this large makes the
// skeleton→data swap height-neutral for the typical profile instead of
// growing the section by a dozen cards when the list lands. Importing the
// shared constant keeps this auto-synced if the cap ever changes.
//
// The keys are INDEX-based on purpose: `crypto.randomUUID()` produced a
// different key set on the server and on the client, so React threw the
// server-rendered pool away and rebuilt it on hydration - the whole
// ~6500px block collapsed and grew again, which is a layout shift of its
// own (and it also broke the hydration of the cards below it).
const skeletonKeys = Array.from(
  { length: MAX_CLOSE_FRIENDS },
  (_, index) => `friends-skeleton-${index}`,
);

function FriendsSection({
  closeFriendsJson,
  friendsVisibility,
  profileReady = false,
}: FriendsSectionProps) {
  const translator = useTranslations('Index');
  const likelyLoggedIn = useLikelyLoggedIn();
  // The GC Name upsell only makes sense while the scraper is reachable:
  // with the local proxy offline no card can show a GC Name, so the banner
  // would be selling a feature that cannot work. 'unknown' (no lookup has
  // finished yet) keeps the banner visible.
  const gcServiceStatus = useGcServiceStatus();

  // Settled-but-empty lists render an explained empty state instead of a
  // bare header: private (Steam refused) and genuinely-empty are different
  // outcomes with different copy. Unresolved (undefined) keeps skeletons;
  // an empty list with UNKNOWN visibility (friends request failed — see
  // getCloseFriendsJson) renders no claim at all, just the header, rather
  // than falsely stating the profile has no friends.
  const renderEmptyState = () => {
    if (
      friendsVisibility !== 'private' &&
      friendsVisibility !== 'empty'
    ) {
      return null;
    }
    if (friendsVisibility === 'private') {
      return (
        <div
          data-testid="friends-private-empty-state"
          className="mt-8 rounded-xl border border-gray-700 bg-gray-800/60 p-6 text-left"
        >
          <p className="text-lg font-semibold text-gray-100">
            {translator('friendsPrivateTitle')}
          </p>
          <p className="mt-2 text-sm text-gray-300">
            {translator('friendsPrivateDescription')}
          </p>
          <p className="mt-2 text-sm text-gray-400">
            {translator('friendsPrivateStillWorks')}
          </p>
        </div>
      );
    }
    return (
      <div
        data-testid="friends-empty-empty-state"
        className="mt-8 rounded-xl border border-gray-700 bg-gray-800/60 p-6 text-left"
      >
        <p className="text-lg font-semibold text-gray-100">
          {translator('friendsEmptyTitle')}
        </p>
        <p className="mt-2 text-sm text-gray-300">
          {translator('friendsEmptyDescription')}
        </p>
      </div>
    );
  };

  // Never collapse to zero height while the friend list is unresolved.
  // Rendering `null` during the `!data && !isLoading` gap (before the fetch
  // kicks off) crushed this section on first paint and banked a huge
  // layout shift as soon as content landed. Home.tsx mounts this section
  // only when !hasNoDataYet, so an unresolved list here always shows the
  // skeleton, never nothing.

  return (
    // No mb here: the player wrapper is flex-col (sticky footer), where
    // margins don't collapse — the footer below already carries mt-12, and
    // keeping mb-12 too would stack 48+48=96px instead of the collapsed 48px
    // this gap has always been. See Home.tsx footer comment.
    <div data-testid="friends-section" className="w-full">
      <SectionTitle translationKey="friendsIRL" />
      {closeFriendsJson
        ? closeFriendsJson.map((f, index) => {
            // Logged-out premium gate: target-independent cards 0 and 1
            // keep GC Name; everything after the banner is locked. Signed-in
            // visitors unlock the whole list. Index-based (not data-based)
            // so the first two visible friends always match the banner copy.
            const allowGcName = likelyLoggedIn || index < 2;
            return (
              <React.Fragment key={f.friend.steamID}>
                <UserCard
                  friend={f.friend}
                  count={f.count}
                  probability={f.probability}
                  itsTargetUser={false}
                  allowGcName={allowGcName}
                />
                {!likelyLoggedIn &&
                  index === 1 &&
                  gcServiceStatus !== 'unavailable' &&
                  closeFriendsJson.length > 2 && (
                    <GamersClubBanner
                      lockedCount={closeFriendsJson.length - 2}
                    />
                  )}
              </React.Fragment>
            );
          })
        : profileReady &&
          skeletonKeys.map((skeletonKey) => (
            <UserCardSkeleton itsTargetUser={false} key={skeletonKey} />
          ))}
      {closeFriendsJson && closeFriendsJson.length === 0 && renderEmptyState()}
    </div>
  );
}

export default FriendsSection;
