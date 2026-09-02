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

export type BanClassification = 'cheat' | 'smurf' | 'other';

export type PlatformBanDetails = {
  faceit: {
    banned: boolean;
    reason: string | null;
    classification: BanClassification | null;
  };
  gamersClub: {
    banned: boolean;
    reason: string | null;
    classification: BanClassification | null;
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
  accountAge?: number;
  totalGamesCount?: number;
  serviceMedalsCount?: number;
  platformBanScore?: number;
  platformBanCheatCount?: number;
  platformBanSmurfCount?: number;
  platformBanOtherCount?: number;
  platformBanDetails?: PlatformBanDetails;
};

export type CheaterDataType = {
  cheaterProbability: number;
  featureObject: FeatureObjectType;
};
