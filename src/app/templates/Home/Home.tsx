'use client';

import React, { useContext, useLayoutEffect } from 'react';
import dynamic from 'next/dynamic';
import { useTranslations } from 'next-intl';

import LanguageSwitcher from '@/app/components/LanguageSwitcher';
import targetInfoJsonType, {
  EnrichedUserSummary,
} from '@/@types/targetInfoJsonType';

import { HomeDataContext, HomeActionsContext } from './context';
import VideoBackground from './sections/VideoBackground';
import MyUserSection from './sections/MyUserSection';
import WelcomeText from './sections/WelcomeText';
import SupportedFormatsSection from './sections/SupportedFormatsSection';

const LocationSection = dynamic(() => import('./sections/LocationSection'));
const FriendsSection = dynamic(() => import('./sections/FriendsSection'));
const CheaterReport = dynamic(() => import('./sections/CheaterReport'));
const PostHeroSections = dynamic(() => import('./sections/PostHeroSections'));
const SponsorMe = dynamic(() => import('@/app/components/SponsorMe'), {
  ssr: false,
  loading: () => null,
});
const SupportMe = dynamic(() => import('@/app/components/SupportMe'), {
  ssr: false,
  loading: () => null,
});

export default function Home({
  initialProfile,
}: {
  initialProfile?: EnrichedUserSummary;
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
    cheaterError,
    showSupportMe,
    isReportOpen,
  } = data;
  const {
    onChangeTarget,
    onCloseSponsorMe,
    onCloseSupportMe,
    retryCheaterReport,
  } = actions;
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
        className={`h-full w-full min-h-screen bg-no-repeat bg-cover px-4 pt-8 md:px-12 md:pt-12 text-white z-20 ${
          hasNoDataYet
            ? // Home keeps its exact original box (flow-root + full padding)
              'flow-root absolute top-1/2 transform -translate-y-1/2 pb-8 md:pb-12'
            : // Player: sticky footer without absolute positioning (which
              // would take the footer out of flow and reintroduce the CLS it
              // was removed for): flex column + min-h-screen, with the
              // sections block below marked flex-1 so it absorbs leftover
              // space and pushes the footer down when the content is shorter
              // than the screen. NOTE `flow-root` is deliberately dropped
              // here — Tailwind orders it after `flex` in the cascade, so
              // keeping both would silently resolve to display:flow-root and
              // disable the sticky behavior. No bottom padding on this
              // branch either: the footer must end flush with the page —
              // wrapper bottom padding would leave a body-background gap
              // below the full-bleed bar on short pages.
              'flex flex-col relative'
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
        {isReportOpen && (
          <CheaterReport
            cheaterData={cheaterData}
            cheaterError={cheaterError}
            nickname={targetInfoJson?.profileInfo?.nickname ?? ''}
            onRetry={retryCheaterReport}
          />
        )}
        {!hasNoDataYet && (
          // flex-1 + mt-8 (NOT my-8): this block absorbs leftover vertical
          // space to pin the footer down on short pages. Dropping mb-8 keeps
          // the sections→footer gap identical to the old collapsed
          // block-flow value (max(mb-8, mt-12) = mt-12 = 48px): in flex,
          // margins don't collapse, so keeping mb-8 would add 32px here on
          // every player page. Tall pages render pixel-identical.
          <div className="flex flex-col gap-16 mt-8 flex-1">
            <LocationSection
              possibleLocationJson={possibleLocationJson}
              targetInfoJson={targetInfoJson}
            />
            <FriendsSection closeFriendsJson={closeFriendsJson} />
          </div>
        )}
        {/* FOOTER */}
        {/* Full-bleed footer: -mx-4 md:-mx-12 cancels the parent container's
            px-4 md:p-12 horizontal padding so the bar spans edge-to-edge while
            staying relative (in flow) — the P2 CLS fix requires it NOT to be
            absolutely positioned. Keep these margins in sync if the parent's
            horizontal padding ever changes. mt-12 is load-bearing too: the
            player wrapper is flex-col (sticky footer), where margins don't
            collapse, and the sections block above carries mt-8 WITHOUT mb-8
            precisely so this gap stays 48px as before. */}
        <footer className="relative -mx-4 md:-mx-12 mt-12 py-6 text-center text-gray-400 text-sm border-t border-gray-700 bg-gray-800">
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
