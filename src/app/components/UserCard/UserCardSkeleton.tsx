import React from 'react';

function UserCardSkeleton({ itsTargetUser }: { itsTargetUser: boolean }) {
  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  return (
    <div
      className={`mt-8 gap-4 flex md:flex-row flex-col items-center justify-center text-white p-4 ${
        itsTargetUser
          ? 'text-lg md:w-[90%] w-full self-center'
          : 'text-base w-full'
      } ${glassmorphism}`}
    >
      <div className="animate-pulse">
        <div
          className={`rounded-lg bg-gray-500 ${
            itsTargetUser ? 'w-36 h-36' : 'w-20 h-20'
          }`}
        />
      </div>
      <div className="flex flex-col w-full break-words gap-y-2">
        <div className="h-5 bg-gray-500 rounded-md animate-pulse w-3/4" />
        <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/2" />
        <div className="flex gap-x-2 items-center">
          <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/4" />
        </div>
        <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/3" />
        <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/2" />
      </div>
    </div>
  );
}

export default UserCardSkeleton;
