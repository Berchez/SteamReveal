import type { MutableRefObject } from 'react';
import { createContext } from 'react';
import { CheaterDataType } from '@/@types/cheaterDataType';
import { isLoadingType } from '@/@types/isLoadingType';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import { locationDataIWant } from '@/@types/locationDataIWant';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { UserSummary } from 'steamapi';

// Split in two: state changes on almost every fetch tick, actions are
// stable references (wrapped in useCallback in useHome.ts). Consumers that
// only need actions (e.g. a "search friend" button) no longer re-render
// when unrelated state like isLoading or targetInfoJson changes.

interface HomeDataContextType {
  closeFriendsJson: closeFriendsDataIWant[] | undefined;
  targetValue: MutableRefObject<string | null | undefined>;
  possibleLocationJson: locationDataIWant[] | undefined;
  targetInfoJson: targetInfoJsonType | undefined;
  isLoading: isLoadingType;
  hasNoDataYet: boolean;
  showSponsorMe: boolean;
  cheaterData: CheaterDataType | undefined;
  showSupportMe: boolean;
}

interface HomeActionsContextType {
  onChangeTarget: (value: string) => void;
  onCloseSponsorMe: (days: number) => void;
  onCloseSupportMe: (days: number) => void;
  getCheaterProbability: () => Promise<CheaterDataType | null>;
  navigateToPlayer: (steamId: string) => void;
  seedInitialProfile: (profile: UserSummary | undefined) => void;
}

export const HomeDataContext = createContext<HomeDataContextType | null>(null);
export const HomeActionsContext = createContext<HomeActionsContextType | null>(
  null,
);
