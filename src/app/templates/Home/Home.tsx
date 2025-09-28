'use client';

import React, { useMemo } from 'react';
import dynamic from 'next/dynamic';
import SponsorMe from '@/app/components/SponsorMe';
import useHome from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import WelcomeText from './WelcomeText/WelcomeText';
import HomeContext from './context';
import CheaterReport from './templates/CheaterReport';

const LocationSection = dynamic(() => import('./templates/LocationSection'));
const FriendsSection = dynamic(() => import('./templates/FriendsSection'));

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    hasNoDataYet,
    showSponsorMe,
    onCloseSponsorMe,
    cheaterData,
    getCheaterProbability,
  } = useHome();

  const contextValue = useMemo(
    () => ({
      handleGetInfoClick,
      getCheaterProbability,
      isLoading,
    }),
    [handleGetInfoClick, getCheaterProbability, isLoading],
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
        {hasNoDataYet && <WelcomeText />}
        <div
          className={`flex flex-col h-full w-full min-h-screen bg-no-repeat bg-cover p-12 text-white z-20 ${
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
          />

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
