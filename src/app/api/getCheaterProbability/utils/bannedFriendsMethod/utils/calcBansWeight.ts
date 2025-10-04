const calcBansWeight = (
  bansInfo: {
    vacBans: number;
    gameBans: number;
    economyBan: string;
    communityBanned: boolean;
  },
  closeFriendCount: number,
): number => {
  const vac = bansInfo.vacBans || 0;
  const game = bansInfo.gameBans || 0;
  const econ = bansInfo.economyBan !== 'none' ? 1 : 0;
  const community = bansInfo.communityBanned ? 1 : 0;

  return 3 ** ((vac + game + econ + community) * closeFriendCount);
};

export default calcBansWeight;
