import axios from 'axios';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import useSupportMe from '@/app/components/SupportMe/useSupportMe';

import { useRunGuard } from './run-guard/useRunGuard';
import usePlayerUrlSync from './url-sync/usePlayerUrlSync';
import useHomeSearch from './search/useHomeSearch';
import useCheaterProbability from './cheater-risk/useCheaterProbability';

export { getAnalyticsSkipHeaders } from '../shared/analytics/homeAnalyticsUtils';

export async function fetchSteamId(target: string) {
  const response = await axios.get('/api/getSteamId', {
    params: {
      target,
    },
  });

  return response.data.steamId;
}

/**
 * Composition root: only connects the specialized hooks to each other and
 * returns exactly the same public interface that the monolithic useHome.ts
 * returned before. HomeProvider.tsx, Home.tsx, context.ts, and
 * MyUserSection.tsx do not require any changes.
 */
const useHome = () => {
  const runGuard = useRunGuard();

  const { showSponsorMe, handleShowSponsorMe, onCloseSponsorMe } =
    useSponsorMe();

  const { showSupportMe, handleShowSupportMe, onCloseSupportMe } =
    useSupportMe();

  const {
    navigateToPlayer,
    syncPlayerUrl,
    consumeSyncedUrlPlayer,
    clearSyncedUrlPlayer,
  } = usePlayerUrlSync(runGuard.reserveNewRun);

  const {
    onChangeTarget,
    closeFriendsJson,
    targetValue,
    possibleLocationJson,
    targetInfoJson,
    isLoading,
    setIsLoading,
    hasNoDataYet,
    cheaterData,
    setCheaterData,
    lastSearchIdRef,
    seedInitialProfile,
  } = useHomeSearch({
    runGuard,
    syncPlayerUrl,
    consumeSyncedUrlPlayer,
    clearSyncedUrlPlayer,
    handleShowSponsorMe,
    handleShowSupportMe,
  });

  const { getCheaterProbability } = useCheaterProbability({
    runGuard,
    isLoadingFriendsCards: isLoading.friendsCards,
    setIsLoading,
    targetInfoJson,
    closeFriendsJson,
    setCheaterData,
    handleShowSupportMe,
    lastSearchIdRef,
  });

  return {
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
    navigateToPlayer,
    showSupportMe,
    onCloseSupportMe,
    seedInitialProfile,
  };
};

export default useHome;
