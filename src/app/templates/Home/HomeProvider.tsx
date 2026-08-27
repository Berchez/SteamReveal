'use client';

import React, { useMemo } from 'react';
import { HomeDataContext, HomeActionsContext } from './context';
import useHome from './hooks/useHome';

export default function HomeProvider({
  children,
}: {
  children: React.ReactNode;
}) {
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
    onChangeTarget,
    onCloseSponsorMe,
    onCloseSupportMe,
    getCheaterProbability,
    navigateToPlayer,
  } = useHome();

  // Data changes on nearly every render (fetch progress, cache hits, etc) —
  // this memo just avoids rebuilding the object identity when unrelated
  // renders happen (e.g. a parent re-render with no state change here).
  const dataValue = useMemo(
    () => ({
      closeFriendsJson,
      targetValue,
      possibleLocationJson,
      targetInfoJson,
      isLoading,
      hasNoDataYet,
      showSponsorMe,
      cheaterData,
      showSupportMe,
    }),
    [
      closeFriendsJson,
      targetValue,
      possibleLocationJson,
      targetInfoJson,
      isLoading,
      hasNoDataYet,
      showSponsorMe,
      cheaterData,
      showSupportMe,
    ],
  );

  // Actions are wrapped in useCallback inside useHome.ts, so their
  // references are stable across renders — this memo then only changes
  // identity if useHome itself re-creates one of them (locale change,
  // etc), not on every data tick. Consumers that only read actions
  // (e.g. the "search friend" link) skip re-renders entirely now.
  const actionsValue = useMemo(
    () => ({
      onChangeTarget,
      onCloseSponsorMe,
      onCloseSupportMe,
      getCheaterProbability,
      navigateToPlayer,
    }),
    [
      onChangeTarget,
      onCloseSponsorMe,
      onCloseSupportMe,
      getCheaterProbability,
      navigateToPlayer,
    ],
  );

  return (
    <HomeActionsContext.Provider value={actionsValue}>
      <HomeDataContext.Provider value={dataValue}>
        {children}
      </HomeDataContext.Provider>
    </HomeActionsContext.Provider>
  );
}
