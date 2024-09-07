'use client';
import LocationCard from '../components/LocationCard/LocationCard';
import LocationCardSkeleton from '../components/LocationCard/LocationCardSkeleton';
import UserCard from '../components/UserCard';
import UserCardSkeleton from '../components/UserCard/UserCardSkeleton';
import { usePage } from './usePage';
import { useTranslations } from 'next-intl';

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
  } = usePage();

  const translator = useTranslations('Index');

  return (
    <>
      <video
        src="/videos/background.mp4"
        loop
        autoPlay
        muted
        className="object-cover w-screen h-screen fixed top-0 left-0 z-0 brightness-90"
      />

      <div className="flex flex-col h-full w-full min-h-screen bg-no-repeat bg-cover p-12 text-white absolute z-10">
        <div className="flex flex-col h-full w-full items-center justify-center gap-y-8">
          <h1 className="text-3xl font-bold text-center">
            {translator('searchTitle')}
          </h1>
          <input
            className="w-full md:w-[75%] h-12 px-4 md:text-sm text-xs text-center text-white bg-gray-800/75 border border-gray-500 rounded-full md:focus:focus:text-base focus:text-sm   focus:border-blue-500 "
            onChange={({ target }) => onChangeTarget(target.value)}
            placeholder={translator('inputSearchPlaceholder')}
            onKeyDown={(e) =>
              handleGetInfoClick(targetValue.current ?? '', e.key)
            }
          />
          {targetInfoJson ? (
            <UserCard friend={targetInfoJson.profileInfo} itsTargetUser />
          ) : (
            isLoading.myCard && <UserCardSkeleton itsTargetUser />
          )}
        </div>

        <div className="flex flex-col gap-16 my-8">
          {(possibleLocationJson || isLoading.friendsCards) && (
            <div>
              <h1 className="text-2xl font-bold text-gray-100">
                {translator('userPossibleLocation')}
              </h1>
              {possibleLocationJson ? (
                <LocationCard
                  possibleLocations={possibleLocationJson}
                  providedLocation={{
                    cityName: targetInfoJson?.targetLocationInfo?.city?.name,
                    stateName: targetInfoJson?.targetLocationInfo?.state?.name,
                    countryName:
                      targetInfoJson?.targetLocationInfo?.country?.name,
                    countryCode:
                      targetInfoJson?.targetLocationInfo?.country?.code,
                  }}
                />
              ) : (
                <LocationCardSkeleton />
              )}
            </div>
          )}
          <div className="w-full mb-8">
            {(closeFriendsJson || isLoading.friendsCards) && (
              <h1 className="text-2xl font-bold text-gray-100">
                {translator('friendsIRL')}
              </h1>
            )}
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
              : isLoading.friendsCards &&
                Array.from({ length: 5 }).map((_, index) => (
                  <UserCardSkeleton key={index} itsTargetUser={false} />
                ))}
          </div>
        </div>
      </div>
    </>
  );
}
