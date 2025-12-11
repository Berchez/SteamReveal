'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import SponsorMe from '@/app/components/SponsorMe';
import SupportMe from '@/app/components/SupportMe';
import useHome from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import WelcomeText from './WelcomeText/WelcomeText';
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
          className={`flex flex-col h-full w-full min-h-screen bg-no-repeat bg-cover py-8 px-4 md:p-12 text-white z-20 ${
            hasNoDataYet
              ? 'absolute top-1/2 transform -translate-y-1/2'
              : 'relative'
          }`}
        >
          <MyUserSection
            targetInfoJson={targetInfoJson}
            isLoading={isLoading.myCard}
            onChangeTarget={onChangeTarget}
            targetValue={targetValue}
            className={hasNoDataYet ? 'mt-[25vh]' : ''}
          />

          {hasNoDataYet && <SupportedFormatsSection />}

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
        </div>
      </div>
    </HomeContext.Provider>
  );
}
