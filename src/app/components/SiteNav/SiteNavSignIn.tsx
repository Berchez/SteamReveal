'use client';

import React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname } from '@/navigation';
import resolveLoginNext from '@/lib/watch/loginNext';

/**
 * Logged-out navbar sign-in cluster (single-state model): step 1 is the
 * bot friendship — the explicit opt-in the login gate requires — and
 * step 2 is the Steam sign-in. The bot-profile chip opens Steam in a
 * new tab so the user can add the friend and come straight back.
 *
 * botProfileUrl is null when the server env lacks a valid
 * STEAM_BOT_STEAMID: the chip hides (degraded navbar) and the callback
 * gate teaches the flow through the auth=nofriend toast instead —
 * global chrome never breaks over a missing env var.
 *
 * The sign-in preserves the page the user is ON as the post-login
 * `next` (the navbar is global — a sign-in from /player/x must return
 * to /player/x, not the home page). The login route re-validates `next`
 * as an internal path server-side, so this is convenience, not a trust
 * boundary.
 */
function SiteNavSignIn({ botProfileUrl }: { botProfileUrl: string | null }) {
  const t = useTranslations('Watch');
  const locale = useLocale();
  const pathname = usePathname();
  const next = resolveLoginNext(pathname, locale);

  return (
    <div className="flex items-center gap-2">
      {botProfileUrl !== null && (
        <a
          href={botProfileUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-11 items-center gap-1.5 rounded-full border border-gray-500 px-4 text-sm font-semibold text-gray-200 hover:border-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-purple-400"
        >
          {t('watchSignInAddBot')}
          <svg
            aria-hidden="true"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M7 17L17 7" />
            <path d="M8 7h9v9" />
          </svg>
        </a>
      )}
      <a
        href={`/api/auth/steam/login?next=${encodeURIComponent(next)}`}
        className="inline-block h-11 px-4 rounded-full bg-purple-600 hover:bg-purple-700/90 text-white font-semibold text-sm leading-[2.75rem]"
      >
        {t('watchNavSignIn')}
      </a>
    </div>
  );
}

export default SiteNavSignIn;
