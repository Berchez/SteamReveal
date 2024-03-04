import { useTranslations } from 'next-intl';
import React from 'react';
import { UserSummary } from 'steamapi';

const UserCard = ({
  friend,
  count,
  probability,
}: {
  friend: UserSummary;
  count?: number;
  probability?: number;
}) => {
  const translator = useTranslations('UserCard');

  return (
    <div
      className="mt-8 bg-white text-slate-800 p-4 rounded-md shadow-sm"
      key={friend.steamID}
    >
      <p className="font-semibold">
        {translator('nickname')}: {friend.nickname}
      </p>
      <p>
        {translator('realName')}: {friend.realName}
      </p>
      <p>
        {translator('probability')}: {probability?.toFixed(2)}%
      </p>
      <p>
        {translator('url')}:{' '}
        <a
          href={friend.url}
          target="_blank"
          rel="noreferrer"
          className="text-blue-500 hover:text-blue-700"
        >
          {friend.url}
        </a>
      </p>
      <p>
        {translator('reliability')}: {count}
      </p>
    </div>
  );
};

export default UserCard;
