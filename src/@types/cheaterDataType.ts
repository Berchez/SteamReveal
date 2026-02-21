import { CsStats } from './csStatsTypes';

export type FeatureObjectType = {
  badCommentsScore: number;
  bannedFriendsScore: number;
  inventoryScore: number;
  playTimeScore: number;
  userLevel: number;
  csStats: CsStats;
};

export type CheaterDataType = {
  cheaterProbability: number;
  featureObject: FeatureObjectType;
};
