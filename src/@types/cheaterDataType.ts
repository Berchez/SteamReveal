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
    /**
     * Whether the FACEIT lookup completed. Same semantics as
     * gamersClub.checked — false means "never verified" (missing key,
     * timeout, /bans rejection); a 404 ("no account") IS verified (true).
     * Optional: legacy shapes without it stay cacheable.
     */
    checked?: boolean;
  };
  gamersClub: {
    banned: boolean;
    reason: string | null;
    classification: BanClassification | null;
    /** Matches/sessions played on GamersClub (best-effort activity signal). */
    matches?: number | null;
    /**
     * Whether the GamersClub lookup completed. False means "never
     * verified" (proxy down/timeout/misconfigured) — NOT "clean". The
     * client uses it to avoid caching an unverified verdict. Optional so
     * legacy/test shapes without it keep compiling (absent reads as
     * cacheable, the pre-flag behavior); the producer always sets it.
     */
    checked?: boolean;
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
  /** Whole months since creation (companion to accountAge, for sub-one-year display). */
  accountAgeMonths?: number;
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
