import React from 'react';
import { useTranslations } from 'next-intl';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import { closeFriendsDataIWant } from '../../../../../@types/closeFriendsDataIWant';

type FriendsSectionProps = {
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
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

function FriendsSection({ closeFriendsJson }: FriendsSectionProps) {
  const translator = useTranslations('Index');

  // Never collapse to zero height while the friend list is unresolved.
  // Rendering `null` during the `!data && !isLoading` gap (before the fetch
  // kicks off) crushed this section on first paint and banked a huge
  // layout shift as soon as content landed. Home.tsx mounts this section
  // only when !hasNoDataYet, so an unresolved list here always shows the
  // skeleton, never nothing.

  return (
    <div className="w-full mb-12">
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
    </div>
  );
}

export default FriendsSection;
