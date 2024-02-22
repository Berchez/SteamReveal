import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';

export const revalidate = 0;

type UserFriend = {
  steamID: string;
  friendedTimestamp: number;
  relationship: string;
};

const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const getFriendsOfFriends = async (friendList: Array<UserFriend>) => {
  let friendsOfFriends: Array<UserFriend> = [];
  await Promise.all(
    friendList.map(async (friend: UserFriend) => {
      try {
        const list = await steam.getUserFriends(friend.steamID);
        friendsOfFriends.push(...list);
      } catch (error) {}
    }),
  );

  return friendsOfFriends;
};

const getCloseFriends = async (target: string) => {
  const friendsOfTheTarget = await steam.getUserFriends(target);
  const friedsOfFriendsOfTheTarget = await getFriendsOfFriends(
    friendsOfTheTarget,
  );

  let closeFriendsOfTheTarget = await Promise.all(
    friendsOfTheTarget.map(async (friend: UserFriend) => {
      return {
        friend: await steam.getUserSummary(friend.steamID),
        count: friedsOfFriendsOfTheTarget.filter(
          (f: UserFriend) => f.steamID === friend.steamID,
        ).length,
      };
    }),
  );

  closeFriendsOfTheTarget.sort((a, b) => b.count - a.count);

  return closeFriendsOfTheTarget.slice(0, 10);
};

export async function POST(req: Request) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();

      const { target } = body;

      const targetSteamId = await steam.resolve(target);
      const targetCloseFriends = await getCloseFriends(targetSteamId);

      console.log('walter result', targetCloseFriends);

      return NextResponse.json({ message: 'Deu certo' }, { status: 200 });
    } catch (error) {
      return NextResponse.json(
        { message: 'Erro interno do servidor ' + (error as Error).message },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Método não permitido.' });
  }
}
