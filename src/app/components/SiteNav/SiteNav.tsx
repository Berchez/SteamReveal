import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import React from 'react';

import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import WatchInbox from '@/app/components/WatchInbox';
import { isSteamId64 } from '@/lib/steamId';

import { resolveSiteNavState } from './siteNavState';
import SiteNavMenu from './SiteNavMenu';
import SiteNavSignIn from './SiteNavSignIn';

/**
 * Global site navbar cluster (fixed top-right, every route): language
 * switcher + [bell + avatar menu | sign-in link].
 *
 * Async Server Component: session and avatar resolve server-side (no
 * client fetch, no first-paint flash, no secrets near the browser) via
 * resolveSiteNavState, which degrades to logged-out on ANY failure —
 * global chrome must never 500 the page tree (see that module for the
 * blast-radius contract). A failed avatar lookup degrades further to the
 * letter fallback inside the menu — never a broken navbar.
 */
export default async function SiteNav({ locale }: { locale: string }) {
  const state = await resolveSiteNavState(cookies());
  const t = await getTranslations({ locale, namespace: 'Watch' });

  // Single-state pre-login step 1: the bot profile link (adding the bot
  // IS the opt-in the login gate requires). Null on missing/invalid env —
  // the chip hides, the sign-in pill still works, and the callback gate
  // teaches the flow through the auth=nofriend toast instead. Same
  // fail-open posture as the rest of global chrome.
  const botSteamId = process.env.STEAM_BOT_STEAMID;
  const botProfileUrl =
    typeof botSteamId === 'string' && isSteamId64(botSteamId)
      ? `https://steamcommunity.com/profiles/${botSteamId}`
      : null;

  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
      <LanguageSwitcher />
      {state.steamId === null ? (
        <SiteNavSignIn botProfileUrl={botProfileUrl} />
      ) : (
        <>
          <WatchInbox steamId={state.steamId} />
          <SiteNavMenu
            steamId={state.steamId}
            nickname={state.nickname}
            avatarUrl={state.avatarUrl}
            avatarAlt={t('watchAvatarAlt', { nickname: state.nickname })}
            initialWatch={state.initialWatch}
          />
        </>
      )}
    </div>
  );
}
