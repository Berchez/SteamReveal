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
/**
 * Canonical order of CS-stat fields as sent to the cheater-probability
 * model (see route.ts → `/api/getCheaterProbability` → Flask `/predict`).
 * This is the SINGLE SOURCE OF TRUTH for that order.
 *
 * route.ts builds its feature vector by mapping over this array (by field
 * name), instead of `Object.values(csStats)` — which depended on the
 * insertion order of the `merged` object literal below and could silently
 * desync if a field were ever added, removed, or reordered there.
 *
 * If you add/remove/rename a CsStats field, you MUST update this list AND
 * the Flask model's expected input order at the same time — they are not
 * checked against each other automatically.
 */
export const CS_STATS_FIELD_ORDER: ReadonlyArray<keyof CsStats> = [
  'leetifyRating',
  'kd',
  'headAccuracy',
  'winrate',
  'totalMatches',
  'killsPerRound',
  'spottedAccuracy',
  'timeToDamage',
  'sprayAccuracy',
];

/**
 * Throws if `stats` doesn't have exactly the fields listed in
 * CS_STATS_FIELD_ORDER (no missing, no unexpected extras).
 *
 * Call this right before building the model's feature vector so a shape
 * mismatch fails loudly (500, logged) at request time instead of silently
 * shipping a cheater-probability prediction computed from misaligned data.
 */
export const assertCsStatsShape = (stats: CsStats): void => {
  const actualKeys = Object.keys(stats).sort();
  const expectedKeys = [...CS_STATS_FIELD_ORDER].sort();

  const missing = expectedKeys.filter((key) => !actualKeys.includes(key));
  const extra = actualKeys.filter(
    (key) => !expectedKeys.includes(key as keyof CsStats),
  );

  if (missing.length || extra.length) {
    throw new Error(
      `CsStats shape mismatch — CS_STATS_FIELD_ORDER (utils/csStats/index.ts) ` +
        `is out of sync with the object returned by getCsStats(). ` +
        `Missing: [${missing.join(', ')}] Extra: [${extra.join(', ')}]`,
    );
  }
};

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
  // IMPORTANT - The order of the features are SUPER important do not reorder then without needed
  const merged: CsStats = {
    leetifyRating: v3?.leetifyRating || legacy?.leetifyRating || '',
    // KD and KPR are only computable from game-level data in the legacy endpoint
    kd: legacy?.kd || '',
    headAccuracy: v3?.headAccuracy || '',
    winrate: v3?.winrate || legacy?.winrate || '',
    totalMatches: v3?.totalMatches || legacy?.totalMatches || '',
    killsPerRound: legacy?.killsPerRound || '',
    spottedAccuracy: v3?.spottedAccuracy || '',
    timeToDamage: v3?.timeToDamage || '',
    sprayAccuracy: v3?.sprayAccuracy || '',
  };

  return merged;
};

export default getCsStats;
