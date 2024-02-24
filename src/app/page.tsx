'use client';
import usePage from './usePage';

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
  } = usePage();

  return (
    <div className="h-full w-full min-h-screen bg-slate-200 px-12 py-6">
      <input
        className="w-64 h-8 text-black"
        onChange={({ target }) => onChangeTarget(target.value)}
      />
      <button
        className="w-16 h-8 bg-zinc-700 text-slate-50"
        onClick={() => handleGetInfoClick(targetValue.current ?? '')}
      >
        Get Info
      </button>

      <div className="flex gap-x-16 mt-8 text-black">
        <div>
          <h1 className="text-xl font-bold">Friends IRL:</h1>
          {closeFriendsJson &&
            closeFriendsJson.map((f) => (
              <div className="mt-8" key={f.friend.steamID}>
                <p className="mt-1">nickname: {f.friend.nickname}</p>
                <p>real name: {f.friend.realName}</p>
                <p>probability: {f.probability?.toFixed(2)}%</p>
                <p>
                  url:{' '}
                  <a href={f.friend.url} target="_blank">
                    {f.friend.url}
                  </a>
                </p>
                <p>count: {f.count}</p>
              </div>
            ))}
        </div>
        <div>
          <h1 className="text-xl font-bold">Possible Location Of Target</h1>
          {possibleLocationJson &&
            possibleLocationJson.map((l) => (
              <div
                className="mt-8"
                key={`${l.location.countryName}/${l.location.stateName}/${l.location.cityName}`}
              >
                <p className="mt-1">city: {l.location.cityName}</p>
                <p>state: {l.location.stateName}</p>
                <p>country: {l.location.countryName}</p>
                <p>probability: {l.probability.toFixed(2)}%</p>
                <p>count: {l.count}</p>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
