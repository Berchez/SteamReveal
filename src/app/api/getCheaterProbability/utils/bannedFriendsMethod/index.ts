import SteamAPI from 'steamapi';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import calcBansWeight from './utils/calcBansWeight';

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const getBannedFriendsScore = async (
  closeFriends: closeFriendsDataIWant[],
  target: string,
): Promise<number> => {
  const allFriends = await steam.getUserFriends(target);
  const closeFriendsMap = new Map(
    closeFriends.map((cf) => [cf.friend.steamID, cf.count]),
  );

  const bansScoreArr = await Promise.all(
    allFriends.map(async (friend) => {
      const bansInfo = await steam.getUserBans(friend.steamID);
      if (!bansInfo) return 0;

      const count = closeFriendsMap.get(friend.steamID) ?? 1;
      return calcBansWeight(bansInfo, count);
    }),
  );

  const sum = bansScoreArr.reduce((acc, score) => acc + score, 0);
  return sum / bansScoreArr.length;
};

export default getBannedFriendsScore;
