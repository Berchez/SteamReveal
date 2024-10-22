import { useTranslations } from 'next-intl';
import React, { useEffect, useMemo, useState } from 'react';
import { UserSummary } from 'steamapi';
import { getLocationDetails } from '@/app/templates/Home/useHome';
import { LocationInfoType } from '@/@types/targetInfoJsonType';

function UserCard({
  friend,
  count,
  probability,
  itsTargetUser,
}: {
  friend: UserSummary;
  count?: number;
  probability?: number;
  itsTargetUser: boolean;
}) {
  const { countryCode, stateCode, cityID } = friend;

  const translator = useTranslations('UserCard');

  const defaultLocationInfoType = useMemo(
    () => ({
      city: undefined,
      state: undefined,
      country: undefined,
    }),
    [],
  );

  const [isLoadingLocationDetails, setIsLoadingLocationDetails] =
    useState(true);

  const [locationDetails, setLocationDetails] = useState<LocationInfoType>(
    defaultLocationInfoType,
  );

  useEffect(() => {
    setIsLoadingLocationDetails(true);
    getLocationDetails(countryCode, stateCode, cityID)
      .then((res) => setLocationDetails(res || defaultLocationInfoType))
      .finally(() => setIsLoadingLocationDetails(false));
  }, [cityID, countryCode, defaultLocationInfoType, stateCode]);

  const { city, state, country } = locationDetails;

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  return (
    <div
      className={`mt-8 gap-4 flex md:flex-row flex-col items-center justify-center text-white p-4 ${
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
            alt={`Avatar of the user ${friend.nickname}`}
            width={itsTargetUser ? 120 : 60}
            height={itsTargetUser ? 120 : 60}
          />
        </div>
      )}
      <div
        className={`flex flex-col w-full break-words ${
          itsTargetUser && 'gap-y-2'
        }`}
      >
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
            <div className="flex items-center gap-x-1 w-full">
              <img
                src={`https://flagcdn.com/${
                  itsTargetUser ? 'w40' : 'w20'
                }/${friend.countryCode.toLowerCase()}.png`}
                className="w-max h-max"
                alt={`country flag (${friend.countryCode}) of the user ${friend.nickname}`}
                width={itsTargetUser ? 40 : 20}
                height={itsTargetUser ? 28 : 14}
              />
              {isLoadingLocationDetails && (
                <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/2" />
              )}
              {!isLoadingLocationDetails && city && `${city.name}, `}
              {!isLoadingLocationDetails && state && `${state.name}, `}
              {!isLoadingLocationDetails && country && `${country.name}`}
            </div>
          )}
        </div>
        {probability && (
          <p className="">
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
}

export default UserCard;
