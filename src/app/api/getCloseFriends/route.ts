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
  const friendsOfFriends: Array<UserFriend> = [];
  await Promise.all(
    friendList.map(async (friend: UserFriend) => {
      try {
        const list = await steam.getUserFriends(friend.steamID);
        friendsOfFriends.push(...list);
      } catch (error) {
        console.log('');
      }
    }),
  );

  return friendsOfFriends;
};

const getCloseFriends = async (target: string) => {
  let friendsOfTheTarget: UserFriend[];
  try {
    friendsOfTheTarget = await steam.getUserFriends(target);
  } catch (err) {
    throw new Error(
      `GettingFriends: Error getting friends of target: ${target}. ${err}`,
    );
  }

  if (!Array.isArray(friendsOfTheTarget)) {
    return [];
  }

  const friedsOfFriendsOfTheTarget =
    await getFriendsOfFriends(friendsOfTheTarget);

  const closeFriendsOfTheTarget = friendsOfTheTarget.map(
    (friend: UserFriend) => ({
      steamID: friend.steamID,
      count: friedsOfFriendsOfTheTarget.filter(
        (f: UserFriend) => f.steamID === friend.steamID,
      ).length,
    }),
  );

  closeFriendsOfTheTarget.sort((a, b) => b.count - a.count);

  const twentyClosestFriends = closeFriendsOfTheTarget.slice(0, 20);

  const steamIDs = twentyClosestFriends.map((friend) => friend.steamID);

  const summariesArray = await steam.getUserSummary(steamIDs);

  const twentyClosestFriendsWithSummary = twentyClosestFriends.map((friend) => {
    const summary = summariesArray.find(
      (summary) => summary.steamID === friend.steamID,
    );
    return {
      friend: summary || null,
      count: friend.count,
    };
  });

  return twentyClosestFriendsWithSummary;
};

export async function POST(req: Request) {
  if (req.method === 'POST') {
    try {
      const body = await req.json();
      const { target } = body;

      if (!target || target === '' || typeof target !== 'string') {
        return NextResponse.json(
          { message: 'Target inválido. ', target },
          { status: 400 },
        );
      }

      const targetSteamId = await steam.resolve(target);
      const targetCloseFriends = await getCloseFriends(targetSteamId);

      return NextResponse.json(
        { closeFriends: targetCloseFriends },
        { status: 200 },
      );
    } catch (error) {
      return NextResponse.json(
        { message: `Erro interno do servidor: ${(error as Error).message}` },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Método não permitido.' });
  }
}
