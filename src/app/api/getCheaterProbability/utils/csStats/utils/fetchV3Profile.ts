import axios from 'axios';
import { CsStats, LeetifyV3Profile } from '@/@types/csStatsTypes';
import { formatWinrate, normalize, sharedHeaders } from './helpers';

const LEETIFY_V3_BASE = 'https://api-public.cs-prod.leetify.com';

/**
 * Fetches the fields that come directly from /v3/profile.
 * Returns null on any failure so the caller can fall through gracefully.
 */
const fetchV3Profile = async (
  steam64Id: string,
): Promise<Partial<CsStats> | null> => {
  try {
    const { data } = await axios.get<LeetifyV3Profile>(
      `${LEETIFY_V3_BASE}/v3/profile`,
      { params: { steam64_id: steam64Id }, headers: sharedHeaders },
    );

    if (!data) return null;

    const { stats = {}, ranks = {} } = data;

    const timeToDamage =
      typeof stats.reaction_time_ms === 'number' &&
      !Number.isNaN(stats.reaction_time_ms)
        ? String(Math.round(stats.reaction_time_ms))
        : '';

    return {
      leetifyRating: normalize(ranks.leetify),
      headAccuracy: normalize(stats.accuracy_head),
      spottedAccuracy: normalize(stats.accuracy_enemy_spotted),
      sprayAccuracy: normalize(stats.spray_accuracy),
      timeToDamage: normalize(timeToDamage),
      winrate: normalize(formatWinrate(data.winrate)),
      totalMatches:
        data.total_matches != null ? String(data.total_matches) : '',
    };
  } catch {
    return null;
  }
};

export default fetchV3Profile;
