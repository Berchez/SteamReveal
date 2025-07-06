import SteamAPI from 'steamapi';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import calcBansWeight from './utils/calcBansWeight';

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const getBannedFriendsScore = async (
  closeFriends: closeFriendsDataIWant[],
): Promise<number> => {
  if (closeFriends.length === 0) return 0;

  const bansScoreArr = await Promise.all(
    closeFriends.map(async ({ friend, count }) => {
      try {
        const bansInfo = await steam.getUserBans(friend.steamID);
        if (!bansInfo) return 0;
        return calcBansWeight(bansInfo, count);
      } catch (err) {
        console.error(
          `Error fetching bans for SteamID ${friend.steamID}:`,
          err,
        );
        return -1;
      }
    }),
  );

  const sum = bansScoreArr.reduce((acc, score) => acc + score, 0);
  return sum / bansScoreArr.length;
};

export default getBannedFriendsScore;
