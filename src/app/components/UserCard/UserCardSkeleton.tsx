import React from 'react';

function UserCardSkeleton({ itsTargetUser }: { itsTargetUser: boolean }) {
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
      <div className="flex flex-col items-center">
        <div className="animate-pulse">
          <div
            className={`rounded-lg bg-gray-500 ${
              itsTargetUser ? 'w-36 h-36' : 'w-[60px] h-[60px]'
            }`}
          />
        </div>

        {/* Friend cards show a "Search friend" link/button below the avatar */}
        {!itsTargetUser && (
          <div className="w-[60px] py-1 mt-2 h-[26px] rounded-full border border-purple-800 bg-purple-600 bg-opacity-10 animate-pulse" />
        )}

        {/* Target user card shows the UserQuickLinks grid below the avatar */}
        {itsTargetUser && (
          <div className="mt-3 w-full flex justify-center">
            <div
              className="grid gap-2 mx-auto"
              style={{ gridTemplateColumns: 'repeat(4, minmax(30px, 50px))' }}
            >
              {Array.from({ length: 8 }, (_, i) => i).map((i) => (
                <div
                  key={i}
                  className="aspect-square rounded-full bg-gray-500 animate-pulse"
                />
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-col w-full break-words gap-y-2">
        {/* nickname — always present in the real card */}
        <div className="h-5 bg-gray-500 rounded-md animate-pulse w-3/4" />

        {/* realName/gcName row — matches the always-mounted min-h-[1.5rem] in the real card */}
        <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/2 min-h-[1.5rem]" />

        {/* location row */}
        <div className="flex gap-x-2 items-center">
          <div className="h-4 bg-gray-500 rounded-md animate-pulse w-60" />
        </div>

        {/* probability + reliability — friend-only fields */}
        {!itsTargetUser && (
          <>
            <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/3" />
            <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/4" />
          </>
        )}

        {/* url — present on both, but only when friend.url exists on the real card;
            kept unconditional here since we can't know that in advance */}
        <div className="h-4 bg-gray-500 rounded-md animate-pulse w-1/2" />

        {/* bottomChildren (CS2 Anticheat Review button) — target user only */}
        {itsTargetUser && (
          <div className="h-[38px] w-[180px] rounded-xl bg-gray-500 bg-opacity-40 animate-pulse mt-1" />
        )}
      </div>
    </div>
  );
}

export default UserCardSkeleton;
