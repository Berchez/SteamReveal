import SteamAPI from 'steamapi';
import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import getSteamApiKey from '@/lib/getSteamApiKey';
import calcBansWeight from './utils/calcBansWeight';

const steam = new SteamAPI(getSteamApiKey() ?? '');
import { BannedFriendDetail } from '@/@types/cheaterDataType';

const getBannedFriendsScore = async (
  closeFriends: closeFriendsDataIWant[],
): Promise<{ score: number; bannedFriendsDetails: BannedFriendDetail[] }> => {
  if (closeFriends.length === 0) {
    return { score: 0, bannedFriendsDetails: [] };
  }

  try {
    const steamIDs = closeFriends.map((f) => f.friend.steamID);
    const bansInfo = await steam.getUserBans(steamIDs);
    const bansArray = Array.isArray(bansInfo) ? bansInfo : [bansInfo];

    const bannedFriendsDetails: BannedFriendDetail[] = [];
    const bansScoreArr: number[] = [];

    bansArray.forEach((ban) => {
      const friendData = closeFriends.find(
        (f) => f.friend.steamID === ban.steamID,
      );
      if (!friendData) return;

      const weight = calcBansWeight(ban, friendData.count);
      bansScoreArr.push(weight);

      // If there are any bans, add to details
      if (
        ban.vacBans > 0 ||
        ban.gameBans > 0 ||
        ban.communityBanned ||
        ban.economyBan !== 'none'
      ) {
        bannedFriendsDetails.push({
          nickname: friendData.friend.nickname,
          steamID: ban.steamID,
          profileUrl: `https://steamcommunity.com/profiles/${ban.steamID}`,
          bans: {
            vacBans: ban.vacBans,
            gameBans: ban.gameBans,
            communityBanned: ban.communityBanned,
            economyBan: ban.economyBan,
          },
        });
      }
    });

    if (bansScoreArr.length === 0) {
      return { score: 0, bannedFriendsDetails: [] };
    }

    const sum = bansScoreArr.reduce((acc, score) => acc + score, 0);
    return {
      score: sum / bansScoreArr.length,
      bannedFriendsDetails,
    };
  } catch (err) {
    console.error('Error fetching bans for close friends:', err);
    return { score: 0, bannedFriendsDetails: [] };
  }
};

export default getBannedFriendsScore;
