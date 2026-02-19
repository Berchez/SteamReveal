import axios from 'axios';

interface CsStats {
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

const LEETIFY_BASE = 'https://api-public.cs-prod.leetify.com';
const LEETIFY_API_KEY = process.env.LEETIFY_API_KEY;

const headers = LEETIFY_API_KEY
  ? {
      _leetify_key: LEETIFY_API_KEY,
    }
  : undefined;

const normalize = (value?: string): string => {
  console.log('walter ass', value, typeof value);
  if (!value) {
    return '';
  }
  return value.trim().toUpperCase() === 'N/A' ? '' : value.trim();
};

const fmtWinrate = (num?: number): string => {
  if (!num || Number.isNaN(num)) {
    return '';
  }
  return `${Math.round(num * 100)}`;
};

/**
 * target: can be steam64 id (numeric) or Leetify id (uuid) — function will try both.
 */
const getCsStats = async (target: string): Promise<CsStats | null> => {
  try {
    if (!target) return null;

    // Try to detect steam64 id (all digits) otherwise use as leetify id

    let leetifyRating = '';
    let headAccuracy = '';
    let spottedAccuracy = '';
    let sprayAccuracy = '';
    let timeToDamage = '';
    let winrate = '';
    let totalMatches = '';
    try {
      const profileRes = await axios.get(`${LEETIFY_BASE}/v3/profile`, {
        params: { steam64_id: target },
        headers,
      });
      // console.log('waltera ', profileRes);
      const profile = profileRes?.data ?? null;

      // console.log('walter profile ', profile);

      if (!profile) return null;

      // Extract stats from profile (if present)
      const stats = profile.stats ?? {};
      const ranks = profile.ranks ?? {};

      leetifyRating = String(ranks?.leetify);

      headAccuracy = String(stats.accuracy_head);
      spottedAccuracy = String(stats.accuracy_enemy_spotted);
      sprayAccuracy = String(stats.spray_accuracy);

      timeToDamage =
        typeof stats.reaction_time_ms === 'number' &&
        !Number.isNaN(stats.reaction_time_ms)
          ? `${Math.round(stats.reaction_time_ms)}`
          : '';

      winrate = fmtWinrate(profile.winrate);

      totalMatches =
        typeof profile.total_matches === 'number'
          ? String(profile.total_matches)
          : '';
    } catch (err) {
      //
    }

    // 2) Fetch recent matches to compute KD and killsPerRound (best-effort)
    let kd = '';
    let killsPerRound = '';

    try {
      const profileWithGames = await axios.get(
        `https://api.cs-prod.leetify.com/api/profile/id/${target}`,
        {
          headers,
        },
      );

      const { data } = profileWithGames;
      const games = data?.games ?? [];

      // Fallback for some data we didnt find earlier
      leetifyRating = String(
        leetifyRating || data?.recentGameRatings?.leetify || '',
      );
      totalMatches = String(
        totalMatches ||
          games?.length ||
          data?.recentGameRatings.gamesPlayed ||
          '',
      );

      if (!winrate) {
        const wins = data.games.filter((g) => g.matchResult === 'win').length;
        winrate = fmtWinrate(wins / data.games.length);
      }

      let totalKills = 0;
      let totalDeaths = 0;
      let totalRounds = 0;

      for (const game of games) {
        if (!game || typeof game !== 'object') continue;

        const kills = Number(game.kills ?? 0);
        const deaths = Number(game.deaths ?? 0);

        const rounds =
          Array.isArray(game.scores) && game.scores.length === 2
            ? Number(game.scores[0] ?? 0) + Number(game.scores[1] ?? 0)
            : 0;

        if (!Number.isNaN(kills)) totalKills += kills;
        if (!Number.isNaN(deaths)) totalDeaths += deaths;
        if (!Number.isNaN(rounds)) totalRounds += rounds;
      }

      if (totalDeaths > 0) {
        kd = (totalKills / totalDeaths).toFixed(2);
      } else if (totalKills > 0) {
        kd = totalKills.toFixed(2);
      }

      if (totalRounds > 0) {
        killsPerRound = (totalKills / totalRounds).toFixed(2);
      }
    } catch (err) {
      // If matches endpoint fails, KD and KPR remain empty (best-effort)
      // console.debug('No matches fetched for KD/KPR calculation', err);
    }

    const result: CsStats = {
      leetifyRating: normalize(leetifyRating),
      kd: normalize(kd),
      headAccuracy: normalize(headAccuracy),
      winrate: normalize(winrate),
      totalMatches: normalize(totalMatches),
      killsPerRound: normalize(killsPerRound),
      spottedAccuracy: normalize(spottedAccuracy),
      timeToDamage: normalize(timeToDamage),
      sprayAccuracy: normalize(sprayAccuracy),
    };

    console.log('walter aa', result);

    return result;
  } catch (error) {
    console.error('Error getting csstats from Leetify API:', error);
    return null;
  }
};

export default getCsStats;
