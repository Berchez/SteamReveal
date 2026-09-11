'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';

/**
 * Logged-out watch gate: Steam OpenID is the only way in (no more
 * SteamID64 text field — identity comes from the verified login, never
 * from typed input). The link carries `next` so the callback returns to
 * this locale's watch flow; `authError` surfaces a failed callback leg
 * (`?auth=error`) instead of failing silently.
 */
function WatchLogin({ authError }: { authError: boolean }) {
  const translator = useTranslations('Watch');
  const locale = useLocale();
  const next = `/${locale}/watch`;

  return (
    <div className="w-full max-w-xl mx-auto flex flex-col gap-y-6 text-center">
      <h1 className="text-2xl font-bold text-gray-100">
        {translator('watchTitle')}
      </h1>
      <p className="text-gray-300">{translator('watchDescription')}</p>
      {authError && (
        <p role="alert" className="text-red-400 text-sm">
          {translator('watchLoginError')}
        </p>
      )}
      <div>
        <a
          href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
          className="inline-block h-12 px-6 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[3rem]"
        >
          {translator('watchLoginButton')}
        </a>
      </div>
    </div>
  );
}

export default WatchLogin;
