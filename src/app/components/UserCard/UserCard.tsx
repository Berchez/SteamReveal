import { useTranslations } from 'next-intl';
import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { UserSummary } from 'steamapi';

import NAVIGATION_OWNED_PARAMS from '@/app/templates/Home/hooks/url-sync/navigationParams';
import { getLocationDetails } from '@/app/templates/Home/hooks/search/homeUtils';
import { Link } from '@/navigation';

import { LocationInfoType } from '@/@types/targetInfoJsonType';
import UserQuickLinks from '../UserQuickLinks';
import useGamersClubName from '../UserQuickLinks/useGamersClubName';

// Avatar and flag image sizes differ depending on whether this card represents
// the searched target user or one of their friends.
const SIZE_CONFIG = {
  target: { avatarSize: 120, flagWidth: 40, flagHeight: 28, flagRes: 'w40' },
  friend: { avatarSize: 60, flagWidth: 20, flagHeight: 14, flagRes: 'w20' },
} as const;

function UserCard({
  friend,
  count,
  probability,
  itsTargetUser,
  bottomChildren,
}: {
  friend: UserSummary;
  count?: number;
  probability?: number;
  itsTargetUser: boolean;
  bottomChildren?: React.ReactNode;
}) {
  const { countryCode, stateCode, cityID, steamID } = friend;

  const translator = useTranslations('UserCard');
  const { name: gcName, isLoading: isLoadingGcName } = useGamersClubName(
    steamID ?? '',
  );

  const sizes = itsTargetUser ? SIZE_CONFIG.target : SIZE_CONFIG.friend;

  const searchParams = useSearchParams();
  const friendHref = useMemo(() => {
    if (!friend.steamID) {
      return undefined;
    }

    const params = new URLSearchParams(searchParams?.toString() ?? '');
    NAVIGATION_OWNED_PARAMS.forEach((key) => params.delete(key));
    const query = params.toString();
    const path = `/player/${encodeURIComponent(friend.steamID)}`;
    return query ? `${path}?${query}` : path;
  }, [friend.steamID, searchParams]);

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

  const gcNameClassName =
    'font-bold bg-[linear-gradient(90deg,#ff3b30,#ff9500,#ffcc00,#34c759,#00c7be,#30b0c7,#5856d6,#af52de)] bg-[length:200%_auto] bg-clip-text text-transparent animate-gradient-spin';

  return (
    <div
      className={`gap-4 flex md:flex-row flex-col items-center justify-center text-white p-4 ${
        itsTargetUser
          ? 'text-lg md:w-[90%] w-full self-center'
          : 'text-base w-full mt-8'
      } ${glassmorphism}`}
    >
      {friend.avatar.medium && (
        <div className="flex flex-col items-center">
          <img
            src={itsTargetUser ? friend.avatar.large : friend.avatar.medium}
            className={`${itsTargetUser ? 'w-36' : ''} rounded-lg`}
            alt={`Avatar of the user ${friend.nickname}`}
            width={sizes.avatarSize}
            height={sizes.avatarSize}
          />
          {!itsTargetUser && friendHref && (
            <Link
              href={friendHref}
              className="inline-flex items-center justify-center w-[60px] py-1 mt-2 text-purple-400 font-semibold text-sm rounded-full border border-purple-800 bg-purple-600 bg-opacity-10 hover:bg-opacity-20"
              aria-label={translator('searchFriend')}
            >
              {translator('searchFriend')}
            </Link>
          )}

          {/* Quick links under avatar for the target user */}
          {itsTargetUser && friend.steamID && (
            <div className="mt-3 w-full flex justify-center">
              <UserQuickLinks steamId={friend.steamID} />
            </div>
          )}
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
        {(friend.realName || gcName || isLoadingGcName) && (
          <p className="flex items-center flex-wrap gap-x-2">
            <span>
              {translator('realName')}:{' '}
              {friend.realName ||
                (isLoadingGcName ? (
                  <span className="inline-block h-4 w-16 bg-gray-500 rounded-md animate-pulse" />
                ) : (
                  <span className={gcNameClassName}>{gcName}</span>
                ))}
            </span>

            {friend.realName && (gcName || isLoadingGcName) && (
              <>
                <span className="text-gray-400 text-sm" aria-hidden="true">
                  |
                </span>

                {isLoadingGcName ? (
                  <span className="inline-block h-4 w-16 bg-gray-500 rounded-md animate-pulse" />
                ) : (
                  <span className={gcNameClassName}>{gcName}</span>
                )}
              </>
            )}
          </p>
        )}

        <div className="flex gap-x-2 items-center">
          {friend.countryCode && (
            <div className="flex items-center gap-x-1 w-full">
              <img
                src={`https://flagcdn.com/${sizes.flagRes}/${friend.countryCode.toLowerCase()}.png`}
                className="w-max h-max"
                alt={`country flag (${friend.countryCode}) of the user ${friend.nickname}`}
                width={sizes.flagWidth}
                height={sizes.flagHeight}
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
        {typeof probability === 'number' && (
          <p className="">
            {translator('probability')}: {probability.toFixed(2)}%
          </p>
        )}
        {friend.url && (
          <p>
            {translator('url')}:{' '}
            <a
              href={friend.url}
              target="_blank"
              rel="noreferrer"
              className="text-blue-500 hover:text-blue-600 hover:underline break-all [overflow-wrap:anywhere]"
            >
              {friend.url}
            </a>
          </p>
        )}
        {typeof count === 'number' && (
          <p>
            {translator('reliability')}: {count}
          </p>
        )}
        {bottomChildren}
      </div>
    </div>
  );
}

export default UserCard;
