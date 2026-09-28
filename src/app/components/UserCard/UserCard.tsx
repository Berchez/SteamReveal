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

// Optional card fields treat null/undefined/"" / whitespace-only as empty,
// so no empty row is ever rendered. The text column below keeps a stable
// min-height with no inter-row gap: missing fields leave blank space at the
// bottom of the card instead of shrinking it or spreading rows apart.
const hasText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

function UserCard({
  friend,
  count,
  probability,
  itsTargetUser,
  bottomChildren,
  preloadedLocationInfo,
}: {
  friend: UserSummary;
  count?: number;
  probability?: number;
  itsTargetUser: boolean;
  bottomChildren?: React.ReactNode;
  // When the caller already resolved the location (e.g. useHomeSearch does
  // this for the target user before this component ever mounts), pass it
  // here to skip the internal fetch entirely. Prevents a redundant
  // getLocationDetails call and its own loading flicker. Friend cards don't
  // have this pre-resolved, so they keep fetching internally as before.
  preloadedLocationInfo?: LocationInfoType;
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

  const [isLoadingLocationDetails, setIsLoadingLocationDetails] = useState(
    !preloadedLocationInfo,
  );

  const [locationDetails, setLocationDetails] = useState<LocationInfoType>(
    preloadedLocationInfo ?? defaultLocationInfoType,
  );

  useEffect(() => {
    if (preloadedLocationInfo) {
      setLocationDetails(preloadedLocationInfo);
      setIsLoadingLocationDetails(false);
      return;
    }

    setIsLoadingLocationDetails(true);
    getLocationDetails(countryCode, stateCode, cityID)
      .then((res) => setLocationDetails(res || defaultLocationInfoType))
      .finally(() => setIsLoadingLocationDetails(false));
  }, [
    cityID,
    countryCode,
    defaultLocationInfoType,
    stateCode,
    preloadedLocationInfo,
  ]);

  const { city, state, country } = locationDetails;

  const gcNameClassName =
    'font-bold bg-[linear-gradient(90deg,#ff3b30,#ff9500,#ffcc00,#34c759,#00c7be,#30b0c7,#5856d6,#af52de)] bg-[length:200%_auto] bg-clip-text text-transparent animate-gradient-spin';

  const hasRealName = hasText(friend.realName);
  const hasGcName = hasText(gcName);
  const showRealNameRow = hasRealName || hasGcName || isLoadingGcName;
  const showGcNameSecond = hasRealName && (hasGcName || isLoadingGcName);

  let realNamePrimary: React.ReactNode = null;
  if (hasRealName) {
    realNamePrimary = friend.realName;
  } else if (isLoadingGcName) {
    realNamePrimary = (
      <span className="inline-block h-4 w-16 bg-gray-500 rounded-md animate-pulse" />
    );
  } else if (hasGcName) {
    realNamePrimary = <span className={gcNameClassName}>{gcName}</span>;
  }

  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

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
            loading={itsTargetUser ? 'eager' : 'lazy'}
            fetchPriority={itsTargetUser ? 'high' : 'auto'}
            decoding="async"
          />
          {!itsTargetUser && friendHref && (
            <Link
              href={friendHref}
              className="inline-flex items-center justify-center w-[60px] py-1 mt-2 text-purple-300 font-semibold text-sm rounded-full border border-purple-600/40 bg-purple-600 bg-opacity-10 hover:bg-opacity-20"
              aria-label={`${translator('searchFriend')} ${friend.nickname}`}
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
      <div className="flex flex-col w-full break-words self-start min-h-[9rem]">
        {hasText(friend.nickname) && (
          <p className="font-semibold">
            {translator('nickname')}: {friend.nickname}
          </p>
        )}
        {showRealNameRow && (
          <p className="flex items-center flex-wrap gap-x-2">
            <span>
              {translator('realName')}: {realNamePrimary}
            </span>

            {showGcNameSecond && (
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

        {hasText(friend.countryCode) && (
          <div className="flex gap-x-2 items-center">
            <div className="flex items-center gap-x-1 w-full">
              <img
                src={`https://flagcdn.com/${sizes.flagRes}/${friend.countryCode.trim().toLowerCase()}.png`}
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
          </div>
        )}
        {typeof probability === 'number' && Number.isFinite(probability) && (
          <p className="">
            {translator('probability')}: {probability.toFixed(2)}%
          </p>
        )}
        {hasText(friend.url) && (
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
        {typeof count === 'number' && Number.isFinite(count) && (
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
