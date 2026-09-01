'use client';

import React, { useContext, useLayoutEffect } from 'react';
import dynamic from 'next/dynamic';
import { UserSummary } from 'steamapi';
import { useTranslations } from 'next-intl';

import SponsorMe from '@/app/components/SponsorMe';
import SupportMe from '@/app/components/SupportMe';
import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import targetInfoJsonType from '@/@types/targetInfoJsonType';

import { HomeDataContext, HomeActionsContext } from './context';
import VideoBackground from './sections/VideoBackground';
import MyUserSection from './sections/MyUserSection';
import WelcomeText from './sections/WelcomeText';
import PostHeroSections from './sections/PostHeroSections';
import SupportedFormatsSection from './sections/SupportedFormatsSection';

const LocationSection = dynamic(() => import('./sections/LocationSection'));
const FriendsSection = dynamic(() => import('./sections/FriendsSection'));
const CheaterReport = dynamic(() => import('./sections/CheaterReport'));

export default function Home({
  initialProfile,
}: {
  initialProfile?: UserSummary;
}) {
  const data = useContext(HomeDataContext);
  const actions = useContext(HomeActionsContext);
  useLayoutEffect(() => {
    actions?.seedInitialProfile(initialProfile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialProfile]);
  if (!data || !actions) {
    throw new Error(
      'Home must be rendered inside HomeProvider (src/app/[locale]/layout.tsx).',
    );
  }
  const {
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    cheaterData,
    showSupportMe,
  } = data;
  const { onChangeTarget, onCloseSponsorMe, onCloseSupportMe } = actions;
  const translator = useTranslations('Index');
  const currentYear = new Date().getFullYear();

  // LCP fix: on the very first render — server-side AND the client's
  // first paint before any layout effect has run — `targetInfoJson` from
  // context is still `undefined` (its initial state comes from the
  // client-only in-memory cache, which is always empty during SSR). That
  // meant MyUserSection rendered UserCardSkeleton in the actual HTML sent
  // to the browser, and the real avatar <img> — our LCP element — only
  // existed after JS downloaded, parsed and hydrated. PageSpeed flagged
  // this directly: "LCP image discoverable from the HTML immediately".
  //
  // `initialProfile` is already fetched server-side (PlayerPage ->
  // getPlayerProfile) specifically for the player this route is
  // rendering, so it's safe to use as a same-render fallback — no effect,
  // no timing gap, so server and client agree on the first paint and
  // there is no hydration mismatch.
  //
  // Scoped ONLY to what MyUserSection needs. LocationSection,
  // FriendsSection, and CheaterReport all keep reading the real
  // `targetInfoJson` from context, completely unchanged — this doesn't
  // touch `hasNoDataYet`, `isLoading`, or any other derived value, and it
  // doesn't affect the seedInitialProfile/getSeededUserInfoJson flow at
  // all: once that effect populates the real `targetInfoJson` in context,
  // this fallback stops being used automatically (targetInfoJson ?? ...
  // just prefers the real value the instant it exists), and the location
  // fills in in-place exactly like it already did before this change.
  const myUserSectionTargetInfoJson: targetInfoJsonType | undefined =
    targetInfoJson ??
    (initialProfile
      ? { profileInfo: initialProfile, targetLocationInfo: {} }
      : undefined);

  return (
    <main className="max-h-dvh">
      <VideoBackground />
      {showSponsorMe && (
        <SponsorMe
          onClose={() => onCloseSponsorMe(0)}
          dontAskAgain={() => onCloseSponsorMe(-30)}
        />
      )}
      {showSupportMe && (
        <SupportMe
          onClose={() => onCloseSupportMe(0)}
          dontAskAgain={() => onCloseSupportMe(-50)}
        />
      )}
      {hasNoDataYet && <WelcomeText />}
      <div className="fixed top-4 right-4 z-50">
        <LanguageSwitcher />
      </div>
      <div
        className={`flow-root h-full w-full min-h-screen bg-no-repeat bg-cover py-8 px-4 md:p-12 text-white z-20 ${
          hasNoDataYet
            ? 'absolute top-1/2 transform -translate-y-1/2'
            : 'relative'
        }`}
      >
        <div className={hasNoDataYet ? 'min-h-[70dvh]' : undefined}>
          <MyUserSection
            targetInfoJson={myUserSectionTargetInfoJson}
            isLoading={isLoading.myCard}
            onChangeTarget={onChangeTarget}
            targetValue={targetValue}
            className={hasNoDataYet ? 'mt-[25vh]' : ''}
          />
          {hasNoDataYet && <SupportedFormatsSection />}
        </div>
        {hasNoDataYet && <PostHeroSections />}
        <CheaterReport
          cheaterData={cheaterData}
          isLoading={isLoading.cheaterReport}
          nickname={targetInfoJson?.profileInfo?.nickname ?? ''}
        />
        <div className="flex flex-col gap-16 my-8">
          <LocationSection
            possibleLocationJson={possibleLocationJson}
            targetInfoJson={targetInfoJson}
            isLoading={isLoading.location}
          />
          <FriendsSection
            closeFriendsJson={closeFriendsJson}
            isLoading={isLoading.friendsCards}
          />
        </div>
        {/* FOOTER */}
        <footer
          className={`absolute left-0 ${hasNoDataYet ? '' : 'bottom-0'} w-full mt-12 py-6 text-center text-gray-400 text-sm border-t border-gray-700 bg-gray-800`}
        >
          <p>
            © {currentYear} SteamReveal. {translator('footer.rights')}
          </p>
          <p>
            {translator('footer.madeWith')}{' '}
            <a
              href="https://github.com/Berchez/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-purple-300 underline"
            >
              Berchez
            </a>
          </p>
        </footer>
      </div>
    </main>
  );
}
