import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import React from 'react';

import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import WatchInbox from '@/app/components/WatchInbox';

import { resolveSiteNavState } from './siteNavState';
import NavLogo from './NavLogo';
import SiteNavMenu from './SiteNavMenu';
import SiteNavSignIn from './SiteNavSignIn';

/**
 * Shared fixed shell for the global navbar (every route): mobile (<sm) is
 * a full-width top bar (logo left, cluster right); desktop (sm+) is the
 * floating top-right cluster over a transparent background. The Suspense
 * fallback in layout.tsx renders this same string so the skeleton and the
 * real cluster occupy identical slots — no layout shift on resolve.
 *
 * Single cluster instance by design (not separate mobile/desktop trees):
 * the bell, avatar menu and switcher mount ONCE, so there are no duplicate
 * interactive controls, no double fetches, and no divergent pollers —
 * responsive classes only change layout, never identity.
 */
export const siteNavContainerClassName =
  'fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-2 bg-[linear-gradient(0deg,rgba(119,0,255,0.2)_0%,rgba(30,0,64,0.4)_50%,rgba(15,0,33,1)_100%)] px-4 py-2 backdrop-blur-md sm:inset-x-auto sm:right-4 sm:top-4 sm:justify-end sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none';

/**
 * Global site navbar: language switcher + [bell + avatar menu | sign-in
 * link], plus the logo on mobile (NavLogo client island — it carries the
 * skeleton/error contract the rest of the cluster gets from the
 * fallback).
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
    <div data-testid="site-nav" className={siteNavContainerClassName}>
      <NavLogo />
      <div className="flex items-center gap-2">
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
    </div>
  );
}
