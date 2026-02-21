import { CsStats } from '@/@types/csStatsTypes';
import fetchLegacyProfile from './utils/fetchLegacyProfile';
import fetchV3Profile from './utils/fetchV3Profile';

/**
 * Fetches CS stats for a given player.
 *
 * Strategy:
 *  1. Call /v3/profile  → provides most accuracy/rating fields directly.
 *  2. Call /api/profile/id/:id → provides calculated KD/KPR and serves as
 *     fallback for any field that /v3/profile did not return.
 *
 * Either source failing independently is non-fatal; the other source fills
 * in what it can. Both failing returns null.
 *
 * @param target - Steam64 ID (numeric string) or Leetify profile UUID.
 */
const getCsStats = async (target: string): Promise<CsStats | null> => {
  if (!target) return null;

  const [v3, legacy] = await Promise.all([
    fetchV3Profile(target),
    fetchLegacyProfile(target),
  ]);

  if (!v3 && !legacy) {
    return null;
  }

  // Merge: v3 is the primary source; legacy fills in any missing values.
  const merged: CsStats = {
    leetifyRating: v3?.leetifyRating || legacy?.leetifyRating || '',
    headAccuracy: v3?.headAccuracy || '',
    spottedAccuracy: v3?.spottedAccuracy || '',
    sprayAccuracy: v3?.sprayAccuracy || '',
    timeToDamage: v3?.timeToDamage || '',
    winrate: v3?.winrate || legacy?.winrate || '',
    totalMatches: v3?.totalMatches || legacy?.totalMatches || '',
    // KD and KPR are only computable from game-level data in the legacy endpoint
    kd: legacy?.kd || '',
    killsPerRound: legacy?.killsPerRound || '',
  };

  return merged;
};

export default getCsStats;
