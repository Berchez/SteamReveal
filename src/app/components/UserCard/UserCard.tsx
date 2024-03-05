import { useTranslations } from 'next-intl';
import React from 'react';
import { UserSummary } from 'steamapi';
import listOfLocation from '../../../../location';

const UserCard = ({
  friend,
  count,
  probability,
  itsTargetUser,
}: {
  friend: UserSummary;
  count?: number;
  probability?: number;
  itsTargetUser: boolean;
}) => {
  const translator = useTranslations('UserCard');

  const country = listOfLocation.countries.find(
    (country) => country.code === friend.countryCode,
  );

  const state = country?.states?.find(
    (state) => state.code === friend.stateCode,
  );

  const city = state?.cities?.find(
    (city) => friend.cityID && city.id === parseInt(friend.cityID),
  );

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  return (
    <div
      className={`mt-8 gap-x-4 flex text-white p-4 ${
        itsTargetUser
          ? 'text-lg md:w-[90%] w-full self-center'
          : 'text-base w-full'
      } ${glassmorphism}`}
      key={friend.steamID}
    >
      {friend.avatar.medium && (
        <div>
          <img
            src={itsTargetUser ? friend.avatar.large : friend.avatar.medium}
            className={`${itsTargetUser ? 'w-36' : ''} rounded-lg`}
          />
        </div>
      )}
      <div className={`flex flex-col ${itsTargetUser && 'gap-y-2'}`}>
        {friend.nickname && (
          <p className="font-semibold">
            {translator('nickname')}: {friend.nickname}
          </p>
        )}
        {friend.realName && (
          <p>
            {translator('realName')}: {friend.realName}
          </p>
        )}
        <div className="flex gap-x-2 items-center">
          {friend.countryCode && (
            <>
              <img
                src={`https://flagcdn.com/${
                  itsTargetUser ? 'w40' : 'w20'
                }/${friend.countryCode.toLowerCase()}.png`}
                className="w-max h-max"
              />
              {city && <p>{city.name},</p>}
              {state && <p>{state.name},</p>}
              {country && <p>{country.name}</p>}
            </>
          )}
        </div>
        {probability && (
          <p>
            {translator('probability')}: {probability?.toFixed(2)}%
          </p>
        )}
        {friend.url && (
          <p>
            {translator('url')}:{' '}
            <a
              href={friend.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-500 hover:text-blue-600 hover:underline"
            >
              {friend.url}
            </a>
          </p>
        )}
        {count && (
          <p>
            {translator('reliability')}: {count}
          </p>
        )}
      </div>
    </div>
  );
};

export default UserCard;
