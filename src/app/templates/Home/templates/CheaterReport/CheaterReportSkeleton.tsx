import { useTranslations } from 'next-intl';
import React from 'react';

function ReportBoxSkeleton({ nickname }: { nickname: string }) {
  const glassmorphism =
    'bg-purple-900 rounded-xl bg-clip-padding backdrop-filter backdrop-blur-sm bg-opacity-20 border-2 text-white p-6 mt-8';
  const translator = useTranslations('CheaterReport');

  return (
    <div className="mt-8">
      <h1 className="text-2xl font-bold text-gray-100">
        {(() => {
          const text = translator('isUserCheaterCS2', { nickname });
          return text.charAt(0).toUpperCase() + text.slice(1);
        })()}
      </h1>
      <div className={`${glassmorphism} border-white animate-pulse`}>
        <div className="flex items-center gap-2 mb-4">
          <div className="w-6 h-6 bg-gray-500 rounded-sm" />
          <div className="h-6 bg-gray-500 rounded-md w-1/3" />
        </div>

        {/* Description */}
        <div className="h-4 bg-gray-500 rounded-md w-2/3 mb-4" />

        {/* List of positive factors */}
        <div className="space-y-2 mb-3">
          <div className="h-4 bg-gray-500 rounded-md w-1/2" />
          <div className="h-4 bg-gray-500 rounded-md w-2/3" />
        </div>

        {/* List of negative factors */}
        <div className="space-y-2">
          <div className="h-4 bg-gray-500 rounded-md w-3/4" />
          <div className="h-4 bg-gray-500 rounded-md w-2/5" />
        </div>
      </div>
    </div>
  );
}

export default ReportBoxSkeleton;
