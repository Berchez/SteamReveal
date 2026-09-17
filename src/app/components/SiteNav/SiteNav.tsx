import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import React from 'react';

import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import WatchInbox from '@/app/components/WatchInbox';

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

  // Login-first model: the logged-out cluster is just the sign-in pill.
  // The bot-profile link lives in the waiting room (fetched from the
  // pending route on first poll), so no bot env is needed up here and
  // global chrome never depends on it.
  return (
    <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
      <LanguageSwitcher />
      {state.steamId === null ? (
        <SiteNavSignIn botOnline={state.botOnline} />
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
