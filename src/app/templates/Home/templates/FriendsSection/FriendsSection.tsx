import React from 'react';
import { useTranslations } from 'next-intl';
import UserCard from '@/app/components/UserCard';
import UserCardSkeleton from '@/app/components/UserCard/UserCardSkeleton';
import { closeFriendsDataIWant } from '../../../../../@types/closeFriendsDataIWant';

type FriendsSectionProps = {
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  isLoading: boolean;
};

function FriendsSection({ closeFriendsJson, isLoading }: FriendsSectionProps) {
  const translator = useTranslations('Index');

  if (!closeFriendsJson && !isLoading) {
    return null;
  }

  return (
    <div className="w-full mb-8">
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
        : isLoading &&
          Array.from({ length: 5 }).map((_, i) => (
            <UserCardSkeleton itsTargetUser={false} key={i} />
          ))}
    </div>
  );
}

export default FriendsSection;
