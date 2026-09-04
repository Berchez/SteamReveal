import getSteamApiKey from '@/lib/getSteamApiKey';
import SteamAPI from 'steamapi';
import { getAccountAge } from '@/app/api/getCheaterProbability/utils/utils';

const steam = new SteamAPI(getSteamApiKey() ?? '');
const CS2_ID = 730;

const MASKED_ZERO_PLAYTIME_MIN_AGE_YEARS = 1;

const hasAnyPositivePlaytime = (
  games: ReadonlyArray<{ minutes?: number }>,
): boolean =>
  games.some((game) => {
    const minutes = game?.minutes;
    return (
      typeof minutes === 'number' &&
      Number.isFinite(minutes) &&
      minutes > 0
    );
  });

const getGameLibraryStats = async (target: string) => {
  try {
    const allGamesArr = await steam.getUserOwnedGames(target);
    if (!Array.isArray(allGamesArr)) {
      console.warn('Invalid response from getUserOwnedGames:', allGamesArr);
      return { playTime: -1, totalGamesCount: -1 };
    }
    const cs2Game = allGamesArr.find((gameObj) => gameObj.game.id === CS2_ID);

    // Steam masks ALL playtime as 0 across the whole library when the
    // account hides its "Game Details" (hours), even though the games list
    // stays public. An account that is not brand new can't realistically
    // have zero minutes on every single game (Steam records minutes from
    // the first launch), so a library-wide zero on a non-fresh account is a
    // privacy mask, not data: report it as unavailable (-1) instead of a
    // misleading "0 hours". When the age can't be determined we stay
    // conservative and keep the reported 0.
    if (
      cs2Game &&
      !cs2Game.minutes &&
      !hasAnyPositivePlaytime(allGamesArr)
    ) {
      let accountIsFresh = true;
      try {
        const summary = await steam.getUserSummary(target);
        const resolved = Array.isArray(summary) ? summary[0] : summary;
        const age = resolved ? getAccountAge(resolved) : undefined;
        if (typeof age === 'number' && !Number.isNaN(age)) {
          accountIsFresh = age < MASKED_ZERO_PLAYTIME_MIN_AGE_YEARS;
        }
      } catch {
        // Summary lookup failed: stay conservative and keep the 0 as-is.
      }

      if (!accountIsFresh) {
        return { playTime: -1, totalGamesCount: allGamesArr.length };
      }
    }

    return {
      playTime: cs2Game?.minutes ?? -1,
      totalGamesCount: allGamesArr.length,
    };
  } catch (err) {
    console.error('Error getting game library stats:', err);
    return { playTime: -1, totalGamesCount: -1 };
  }
};

export default getGameLibraryStats;
