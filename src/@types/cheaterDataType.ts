export type FeatureObjectType = {
  badCommentsScore: number;
  bannedFriendsScore: number;
  inventoryScore: number;
  playTimeScore: number;
  userLevel: number;
  csStats: {
    leetifyRating: string;
    kd: string;
    headAccuracy: string;
    winrate: string;
    totalMatches: string;
    killsPerRound: string;
    spottedAccuracy: string;
    timeToDamage: string;
    sprayAccuracy: string;
  };
};

export type CheaterDataType = {
  cheaterProbability: number;
  featureObject: FeatureObjectType;
};
