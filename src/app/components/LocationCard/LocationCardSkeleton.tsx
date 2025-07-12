import React from 'react';

function LocationCardSkeleton() {
  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border border-gray-100/50';

  return (
    <div className={`mt-8 text-white py-4 px-8 ${glassmorphism}`}>
      <div className="flex flex-col gap-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div
            className="flex md:items-center md:justify-between md:flex-row flex-col mb-2 animate-pulse"
            key={i}
          >
            <div className="flex items-center gap-x-2">
              <div className="w-7 h-6 bg-gray-500" />
              <div className="w-80 h-6 bg-gray-500 rounded-md" />
            </div>
            <div className="flex gap-x-1 mt-2">
              <div className="w-12 h-6 bg-gray-500 rounded-md" />
              <div className="w-6 h-4 mt-2 bg-gray-500 rounded-md" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default LocationCardSkeleton;
