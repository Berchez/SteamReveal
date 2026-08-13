import getSteamApiKey from '@/lib/getSteamApiKey';
import SteamAPI from 'steamapi';

const steam = new SteamAPI(getSteamApiKey() ?? '');
const CS2_ID = 730;

const getGameLibraryStats = async (target: string) => {
  try {
    const allGamesArr = await steam.getUserOwnedGames(target);
    if (!Array.isArray(allGamesArr)) {
      console.warn('Invalid response from getUserOwnedGames:', allGamesArr);
      return { playTime: -1, totalGamesCount: -1 };
    }
    const cs2Game = allGamesArr.find((gameObj) => gameObj.game.id === CS2_ID);
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
