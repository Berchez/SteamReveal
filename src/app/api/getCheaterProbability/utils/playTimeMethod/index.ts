import SteamAPI from 'steamapi';

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');
const CS2_ID = 730;

const getPlayTimeScore = async (target: string) => {
  try {
    const allGamesArr = await steam.getUserOwnedGames(target);

    if (!Array.isArray(allGamesArr)) {
      console.warn('Invalid response from getUserOwnedGames:', allGamesArr);
      return -1;
    }

    const cs2Game = allGamesArr.find((gameObj) => gameObj.game.id === CS2_ID);
    return cs2Game?.minutes ?? 0;
  } catch (err) {
    console.error('Error getting CS2 game time:', err);
    return -1;
  }
};

export default getPlayTimeScore;
