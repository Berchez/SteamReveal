'use client';

import React, { Suspense, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import WatchInbox from '@/app/components/WatchInbox';

import type { SiteNavState } from './siteNavState';
import NavLogo from './NavLogo';
import SiteNavMenu from './SiteNavMenu';
import SiteNavSignIn from './SiteNavSignIn';

export const siteNavContainerClassName =
  'fixed inset-x-0 top-0 z-50 flex items-center justify-between gap-2 bg-[linear-gradient(0deg,rgba(119,0,255,0.2)_0%,rgba(30,0,64,0.4)_50%,rgba(15,0,33,1)_100%)] px-4 py-2 backdrop-blur-md sm:inset-x-auto sm:right-4 sm:top-4 sm:justify-end sm:bg-transparent sm:px-0 sm:py-0 sm:backdrop-blur-none';

const fallbackState: SiteNavState = { steamId: null, botOnline: true };

const isSiteNavState = (value: unknown): value is SiteNavState => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const state = value as Record<string, unknown>;
  if (state.steamId === null) {
    return typeof state.botOnline === 'boolean';
  }

  return (
    typeof state.steamId === 'string' &&
    typeof state.nickname === 'string' &&
    (state.avatarUrl === null || typeof state.avatarUrl === 'string') &&
    (state.initialWatch === null || typeof state.initialWatch === 'object')
  );
};

function SiteNavSkeleton() {
  return (
    <div
      data-testid="site-nav"
      aria-busy="true"
      className={siteNavContainerClassName}
    >
      <NavLogo />
      <div className="flex items-center gap-2">
        <Suspense fallback={<div aria-hidden="true" className="h-11 w-11" />}>
          <LanguageSwitcher />
        </Suspense>
        <div
          aria-hidden="true"
          className="h-11 w-11 animate-pulse rounded-full bg-gray-700/60"
        />
      </div>
    </div>
  );
}

/**
 * Client navbar shell. The root layout must stay static for player-page ISR,
 * so session/identity resolution moved to /api/site-nav: the skeleton paints
 * immediately and the real cluster swaps in once the private state response
 * lands. A failed request degrades to the logged-out cluster (fail-open for
 * bot liveness), matching the old server-side blast-radius contract.
 */
export default function SiteNav() {
  const t = useTranslations('Watch');
  const [state, setState] = useState<SiteNavState | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetch('/api/site-nav', { cache: 'no-store' })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`site nav: ${response.status}`);
        }
        return response.json() as Promise<unknown>;
      })
      .then((body) => {
        if (!cancelled) {
          setState(isSiteNavState(body) ? body : fallbackState);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setState(fallbackState);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (state === null) {
    return <SiteNavSkeleton />;
  }

  return (
    <div data-testid="site-nav" className={siteNavContainerClassName}>
      <NavLogo />
      <div className="flex items-center gap-2">
        <Suspense fallback={<div aria-hidden="true" className="h-11 w-11" />}>
          <LanguageSwitcher />
        </Suspense>
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
