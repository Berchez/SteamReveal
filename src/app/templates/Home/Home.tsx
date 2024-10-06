'use client';

import React from 'react';
import dynamic from 'next/dynamic';
import { useHome } from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import WelcomeText from './WelcomeText/WelcomeText';

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
  } = useHome();

  return (
    <div className="max-h-dvh">
      <VideoBackground />
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
          handleGetInfoClick={handleGetInfoClick}
          targetValue={targetValue}
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
  );
}
