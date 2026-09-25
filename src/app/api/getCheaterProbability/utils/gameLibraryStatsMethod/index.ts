import getSteamApiKey from '@/lib/getSteamApiKey';
import SteamAPI from 'steamapi';
import { isPrivateLibraryShapeError } from '@/lib/isBenignOwnedGamesError';
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
    // Deliberately NARROWER than isBenignOwnedGamesError: this function
    // makes no sibling Steam call, so the string shapes (Unauthorized /
    // Forbidden / Bad Request — identical for "private profile" and "dead
    // API key") cannot be told apart here. Only steamapi's own TypeError
    // on `games.map` qualifies as benign: a dead key yields HTTP 401,
    // never the 200-with-no-`games` shape, so this branch provably cannot
    // hide a key outage. Everything else stays loud. (Backstop, not
    // assumption: the sole production caller — getCheaterProbability —
    // awaits summary/level/bans with the same key in the same request and
    // 500s loudly on any of them, so a dead key is always visible at
    // request level regardless of this line's level.)
    if (isPrivateLibraryShapeError(err)) {
      // eslint-disable-next-line no-console
      console.warn(
        'Owned-games stats unavailable (private/empty library):',
        err instanceof Error ? err.message : err,
      );
    } else {
      // eslint-disable-next-line no-console
      console.error('Error getting game library stats:', err);
    }
    return { playTime: -1, totalGamesCount: -1 };
  }
};

export default getGameLibraryStats;
