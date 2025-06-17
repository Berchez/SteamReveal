import SteamAPI from 'steamapi';

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');
const CS2_ID = 730;

const getPlayTimeScore = async (target: string) => {
  const allGamesArr = await steam.getUserOwnedGames(target);
  const cs2Game = allGamesArr.find((gameObj) => gameObj.game.id === CS2_ID);
  return cs2Game?.minutes ?? 0;
};

export default getPlayTimeScore;
