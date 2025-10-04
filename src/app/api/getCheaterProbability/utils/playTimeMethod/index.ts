import SteamAPI from 'steamapi';

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');
const CS2_ID = 730;

const getPlayTimeScore = async (target: string) => {
  try {
    const allGamesArr = await steam.getUserOwnedGames(target);

    // Check if the response is an array
    if (!Array.isArray(allGamesArr)) {
      console.warn('Invalid response from getUserOwnedGames:', allGamesArr);
      return -1;
    }

    // Look for the CS2 game object in the array
    const cs2Game = allGamesArr.find((gameObj) => gameObj.game.id === CS2_ID);

    // Return the playtime in minutes or 0 if CS2 is not found
    return cs2Game?.minutes ?? 0;
  } catch (err) {
    console.error('Error getting CS2 game time:', err);

    // Return a default value in case of error
    return -1;
  }
};

export default getPlayTimeScore;
