import { CsStats } from './csStatsTypes';

export type BannedFriendDetail = {
  nickname: string;
  steamID: string;
  profileUrl: string;
  bans: {
    vacBans: number;
    gameBans: number;
    communityBanned: boolean;
    economyBan: string;
  };
};

export type FeatureObjectType = {
  badCommentsScore: number;
  bannedFriendsScore: number;
  inventoryScore: number;
  playTimeScore: number;
  userLevel: number;
  csStats: CsStats;
  analyzedFriendsCount: number;
  bannedFriendsDetails?: BannedFriendDetail[];
};

export type CheaterDataType = {
  cheaterProbability: number;
  featureObject: FeatureObjectType;
};
