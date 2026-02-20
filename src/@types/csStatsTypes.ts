export interface CsStats {
  leetifyRating: string;
  kd: string;
  headAccuracy: string;
  winrate: string;
  totalMatches: string;
  killsPerRound: string;
  spottedAccuracy: string;
  timeToDamage: string;
  sprayAccuracy: string;
}

/** Raw shape returned by GET /v3/profile */
export interface LeetifyV3Profile {
  stats?: {
    accuracy_head?: number;
    accuracy_enemy_spotted?: number;
    spray_accuracy?: number;
    reaction_time_ms?: number;
  };
  ranks?: {
    leetify?: number;
  };
  winrate?: number;
  total_matches?: number;
}

/** Raw shape of each game returned by GET /api/profile/id/:id */
export interface LeetifyGame {
  kills?: number;
  deaths?: number;
  scores?: [number, number];
  matchResult?: 'win' | 'loss' | 'tie';
}

/** Raw shape returned by GET /api/profile/id/:id */
export interface LeetifyLegacyProfile {
  recentGameRatings?: {
    leetify?: number;
    gamesPlayed?: number;
  };
  games?: LeetifyGame[];
}
