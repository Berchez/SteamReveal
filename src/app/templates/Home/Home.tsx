'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import SponsorMe from '@/app/components/SponsorMe';
import SupportMe from '@/app/components/SupportMe';
import { useTranslations } from 'next-intl';
import useHome from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import WelcomeText from './WelcomeText';
import PostHeroSections from './PostHeroSections';
import HomeContext from './context';
import CheaterReport from './templates/CheaterReport';
import SupportedFormatsSection from './templates/SupportedFormatsSection';

const LocationSection = dynamic(() => import('./templates/LocationSection'));
const FriendsSection = dynamic(() => import('./templates/FriendsSection'));

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    getCheaterProbability,
    updateQueryParam,
    showSupportMe,
    onCloseSupportMe,
  } = useHome();

  const contextValue = useMemo(
    () => ({
      updateQueryParam,
      getCheaterProbability,
      isLoading,
    }),
    [updateQueryParam, getCheaterProbability, isLoading],
  );

  const translator = useTranslations('Index');

  const currentYear = new Date().getFullYear();

  return (
    <HomeContext.Provider value={contextValue}>
      <div className="max-h-dvh">
        <VideoBackground />
        {showSponsorMe && (
          <SponsorMe
            onClose={() => onCloseSponsorMe(0)}
            dontAskAgain={() => onCloseSponsorMe(-20)}
          />
        )}

        {showSupportMe && (
          <SupportMe
            onClose={() => onCloseSupportMe(0)}
            dontAskAgain={() => onCloseSupportMe(-25)}
          />
        )}

        {hasNoDataYet && <WelcomeText />}

        <div
          className={`flow-root h-full w-full min-h-screen bg-no-repeat bg-cover py-8 px-4 md:p-12 text-white z-20 ${
            hasNoDataYet
              ? 'absolute top-1/2 transform -translate-y-1/2'
              : 'relative'
          }`}
        >
          <div className="min-h-[70dvh]">
            <MyUserSection
              targetInfoJson={targetInfoJson}
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
              isLoading={isLoading.friendsCards}
            />
            <FriendsSection
              closeFriendsJson={closeFriendsJson}
              isLoading={isLoading.friendsCards}
            />
          </div>
          {/* FOOTER */}
          <footer className="absolute left-0 w-full mt-12 py-6 text-center text-gray-400 text-sm border-t border-gray-700 bg-gray-800">
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
      </div>
    </HomeContext.Provider>
  );
}
