import React from 'react';
import { useTranslations } from 'next-intl';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import type { FriendsVisibility } from '@/lib/analytics/types';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import { closeFriendsDataIWant } from '../../../../../@types/closeFriendsDataIWant';

type FriendsSectionProps = {
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  /**
   * How the list resolved. Undefined while loading AND when the friends
   * request failed (unknown — renders no empty-state claim either way).
   * Drives the empty-state copy.
   */
  friendsVisibility?: FriendsVisibility;
};

// Skeleton pool matches the product cap for this list: the route trims the
// computed list to MAX_CLOSE_FRIENDS (GET /api/getCloseFriends slices to
// `slice(0, MAX_CLOSE_FRIENDS)`), and real analytics data shows the median
// profile renders ~18-20 friend cards. A pool this large makes the
// skeleton→data swap height-neutral for the typical profile instead of
// growing the section by a dozen cards when the list lands. Importing the
// shared constant keeps this auto-synced if the cap ever changes.
const skeletonUUIDs = Array.from(
  { length: MAX_CLOSE_FRIENDS },
  () => crypto.randomUUID(),
);

function FriendsSection({
  closeFriendsJson,
  friendsVisibility,
}: FriendsSectionProps) {
  const translator = useTranslations('Index');

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
      <h1 className="text-2xl font-bold text-gray-100">
        {translator('friendsIRL')}
      </h1>
      {closeFriendsJson
        ? closeFriendsJson.map((f) => (
            <UserCard
              friend={f.friend}
              count={f.count}
              probability={f.probability}
              itsTargetUser={false}
              key={f.friend.steamID}
            />
          ))
        : skeletonUUIDs.map((uuid) => (
            <UserCardSkeleton itsTargetUser={false} key={uuid} />
          ))}
      {closeFriendsJson && closeFriendsJson.length === 0 && renderEmptyState()}
    </div>
  );
}

export default FriendsSection;
