import axios from 'axios';
import { CsStats, LeetifyLegacyProfile } from '@/@types/csStatsTypes';
import { calculateWinrateFromGames, normalize, sharedHeaders } from './helpers';

const LEETIFY_LEGACY_BASE = 'https://api.cs-prod.leetify.com';

const fetchLegacyProfile = async (
  target: string,
): Promise<Partial<CsStats> | null> => {
  try {
    const { data } = await axios.get<LeetifyLegacyProfile>(
      `${LEETIFY_LEGACY_BASE}/api/profile/id/${target}`,
      { headers: sharedHeaders },
    );

    if (!data) return null;

    const games = data.games ?? [];

    // ── Aggregate game-level stats safely using reduce ──────────
    const { totalKills, totalDeaths, totalRounds } = games.reduce(
      (acc, game) => {
        if (!game || typeof game !== 'object') {
          return acc;
        }

        const kills = Number(game.kills ?? 0);
        const deaths = Number(game.deaths ?? 0);

        const rounds =
          Array.isArray(game.scores) && game.scores.length === 2
            ? Number(game.scores[0] ?? 0) + Number(game.scores[1] ?? 0)
            : 0;

        return {
          totalKills: acc.totalKills + kills,
          totalDeaths: acc.totalDeaths + deaths,
          totalRounds: acc.totalRounds + rounds,
        };
      },
      { totalKills: 0, totalDeaths: 0, totalRounds: 0 },
    );

    const kd =
      totalDeaths > 0
        ? (totalKills / totalDeaths).toFixed(2)
        : totalKills > 0
          ? totalKills.toFixed(2)
          : '';

    const killsPerRound =
      totalRounds > 0 ? (totalKills / totalRounds).toFixed(2) : '';

    return {
      leetifyRating: normalize(
        data.recentGameRatings?.leetify
          ? data.recentGameRatings.leetify * 100
          : undefined,
      ),
      totalMatches: normalize(
        data.recentGameRatings?.gamesPlayed ?? games.length,
      ),
      winrate: normalize(calculateWinrateFromGames(games)),
      kd: normalize(kd),
      killsPerRound: normalize(killsPerRound),
    };
  } catch {
    return null;
  }
};

export default fetchLegacyProfile;
