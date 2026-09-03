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
    /** Total CS2 matches played on FACEIT (best-effort activity signal). */
    matches?: number | null;
  };
  gamersClub: {
    banned: boolean;
    reason: string | null;
    classification: BanClassification | null;
    /** Matches/sessions played on GamersClub (best-effort activity signal). */
    matches?: number | null;
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
  /**
   * Post-model reduction owed to demonstrable activity on FACEIT/GamersClub.
   * The player is less likely to be a cheater the more they play on a
   * platform whose anti-cheat is more invasive than Valve's VAC.
   */
  platformActivityDiscount?: number;
  faceitActive?: boolean;
  gcActive?: boolean;
};

export type CheaterDataType = {
  cheaterProbability: number;
  featureObject: FeatureObjectType;
};
