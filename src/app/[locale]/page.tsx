'use client';
import UserCard from '../components/UserCard';
import usePage from './usePage';
import { useTranslations } from 'next-intl';

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
  } = usePage();

  const translator = useTranslations('Index');

  return (
    <>
      <video
        src="/videos/background.mp4"
        loop
        autoPlay
        muted
        className="object-cover w-screen h-screen fixed top-0 left-0 z-0"
      />

      <div className="flex flex-col h-full w-full min-h-screen bg-no-repeat bg-cover p-12 text-white absolute z-10">
        <div className="flex flex-col h-full w-full items-center justify-center gap-y-8">
          <h1 className="text-3xl font-bold">{translator('searchTitle')}</h1>
          <input
            className="w-full md:w-[75%] h-12 px-4 text-sm text-center text-white bg-gray-800/75 border border-gray-500 rounded-full focus:text-base  focus:border-blue-500 "
            onChange={({ target }) => onChangeTarget(target.value)}
            placeholder={translator('inputSearchPlaceholder')}
            onKeyDown={(e) =>
              handleGetInfoClick(targetValue.current ?? '', e.key)
            }
          />
        </div>

        {targetInfoJson && <UserCard friend={targetInfoJson} />}

        <div className="flex flex-col md:flex-row gap-16 my-8">
          <div className="w-full md:w-1/2">
            {closeFriendsJson && (
              <>
                <h1 className="text-2xl font-bold text-gray-100">
                  {translator('friendsIRL')}
                </h1>
                {closeFriendsJson.map((f) => (
                  <UserCard
                    friend={f.friend}
                    count={f.count}
                    probability={f.probability}
                  />
                ))}
              </>
            )}
          </div>
          <div className="w-full md:w-1/2">
            {possibleLocationJson && (
              <>
                <h1 className="text-2xl font-bold text-gray-100">
                  {translator('userPossibleLocation')}
                </h1>
                {possibleLocationJson.map((l) => (
                  <div
                    className="mt-8 bg-white text-slate-800 p-4 rounded-md shadow-sm"
                    key={`${l.location.countryName}/${l.location.stateName}/${l.location.cityName}`}
                  >
                    <p className="font-semibold">city: {l.location.cityName}</p>
                    <p>state: {l.location.stateName}</p>
                    <p>country: {l.location.countryName}</p>
                    <p>probability: {l.probability.toFixed(2)}%</p>
                    <p>count: {l.count}</p>
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
