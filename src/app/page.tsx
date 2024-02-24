'use client';
import usePage from './usePage';

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
  } = usePage();

  return (
    <div className="flex flex-col h-full w-full min-h-screen bg-gray-100 p-12 text-gray-800">
      <div className="flex">
        <input
          className="w-full sm:w-96 h-10 px-3 text-black bg-white border border-gray-300 rounded-md shadow-sm focus:border-blue-500 focus:ring focus:ring-blue-200 focus:ring-opacity-50"
          onChange={({ target }) => onChangeTarget(target.value)}
          placeholder="Search..."
        />
        <button
          className="w-full sm:w-16 h-10 text-white bg-blue-600 rounded-md shadow-md hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-400 focus:ring-opacity-50"
          onClick={() => handleGetInfoClick(targetValue.current ?? '')}
        >
          Get Info
        </button>
      </div>

      {targetInfoJson && (
        <div className="mt-8">
          <h1 className="text-2xl font-bold text-gray-800">Target Info</h1>
          <p className="mt-4">nick: {targetInfoJson?.nickname}</p>
          <p>realname: {targetInfoJson?.realName}</p>
          <div className="flex gap-x-2">
            <p>{targetInfoJson?.countryCode}</p>
            <p>{targetInfoJson?.stateCode}</p>
            <p>{targetInfoJson?.cityID}</p>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-16 mt-8">
        <div className="w-full sm:w-1/2">
          {closeFriendsJson && (
            <>
              <h1 className="text-2xl font-bold text-gray-800">Friends IRL:</h1>
              {closeFriendsJson.map((f) => (
                <div
                  className="mt-8 bg-white p-4 rounded-md shadow-sm"
                  key={f.friend.steamID}
                >
                  <p className="font-semibold">nickname: {f.friend.nickname}</p>
                  <p>real name: {f.friend.realName}</p>
                  <p>probability: {f.probability?.toFixed(2)}%</p>
                  <p>
                    url:{' '}
                    <a
                      href={f.friend.url}
                      target="_blank"
                      rel="noreferrer"
                      className="text-blue-500 hover:text-blue-700"
                    >
                      {f.friend.url}
                    </a>
                  </p>
                  <p>count: {f.count}</p>
                </div>
              ))}
            </>
          )}
        </div>
        <div className="w-full sm:w-1/2">
          {possibleLocationJson && (
            <>
              <h1 className="text-2xl mt-16 font-bold text-gray-800">
                Possible Location Of Target:
              </h1>
              {possibleLocationJson.map((l) => (
                <div
                  className="mt-8 bg-white p-4 rounded-md shadow-sm"
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
  );
}
