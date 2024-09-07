'use client';
import React from 'react';
import { useHome } from './useHome';
import VideoBackground from './templates/VideoBackground';
import MyUserSection from './templates/MyUserSection';
import LocationSection from './templates/LocationSection';
import FriendsSection from './templates/FriendsSection/FriendsSection';

export default function Home() {
  const {
    onChangeTarget,
    closeFriendsJson,
    handleGetInfoClick,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
  } = useHome();

  return (
    <>
      <VideoBackground />
      <div className="flex flex-col h-full w-full min-h-screen bg-no-repeat bg-cover p-12 text-white absolute z-10">
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
    </>
  );
}
