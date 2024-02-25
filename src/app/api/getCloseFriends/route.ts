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

  let closeFriendsOfTheTarget = friendsOfTheTarget.map((friend: UserFriend) => {
    return {
      steamID: friend.steamID,
      count: friedsOfFriendsOfTheTarget.filter(
        (f: UserFriend) => f.steamID === friend.steamID,
      ).length,
    };
  });

  closeFriendsOfTheTarget.sort((a, b) => b.count - a.count);

  const twentyClosestFriends = closeFriendsOfTheTarget.slice(0, 20);

  const twentyClosestFriendsWithSummary = await Promise.all(
    twentyClosestFriends.map(async (friend) => {
      return {
        friend: await steam.getUserSummary(friend.steamID),
        count: friend.count,
      };
    }),
  );

  return twentyClosestFriendsWithSummary;
};

export async function POST(req: Request) {
  if (req.method === 'POST') {
    console.log('walter Z');
    return NextResponse.json(
      { closeFriends: [], targetInfo: [] },
      { status: 200 },
    );
    try {
      const body = await req.json();

      const { target } = body;

      if (!target || target === '' || typeof target !== 'string') {
        return NextResponse.json(
          { message: 'Target inválido. ', target },
          { status: 500 },
        );
      }
      console.log('walter A', target);
      const targetSteamId = await steam.resolve(target);
      console.log('walter B', targetSteamId);

      const targetInfo = await steam.getUserSummary(targetSteamId);
      console.log('walter C', targetInfo);
      const targetCloseFriends = await getCloseFriends(targetSteamId);

      return NextResponse.json(
        { closeFriends: targetCloseFriends, targetInfo: targetInfo },
        { status: 200 },
      );
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
