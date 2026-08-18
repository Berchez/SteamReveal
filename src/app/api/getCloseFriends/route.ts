import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';

export const revalidate = 0;

type UserFriend = {
  steamID: string;
  friendedTimestamp: number;
  relationship: string;
};

const steam = new SteamAPI(getSteamApiKey() ?? '');

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
    friendsOfTheTarget = (await steam.getUserFriends(target)).slice(0, 100);
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

  // MAX_CLOSE_FRIENDS is shared with /api/getCheaterProbability's request
  // validation (see Ticket 8, @/lib/closeFriendsLimits). This is the
  // place that actually decides how many close friends the product
  // considers; that other route just caps what it'll accept back from
  // the client at the same number. Change it in one place, both stay in
  // sync.
  const closestFriends = closeFriendsOfTheTarget.slice(0, MAX_CLOSE_FRIENDS);

  const steamIDs = closestFriends.map((friend) => friend.steamID);

  const summaries = await steam.getUserSummary(steamIDs);
  const summariesArray = Array.isArray(summaries) ? summaries : [summaries];

  // Only keep entries whose Steam summary actually resolved. A friend can
  // fail to resolve (private profile, deleted account, a transient gap in
  // the Steam API's response) — this used to ship as `friend: null`,
  // which silently violated closeFriendsDataIWant's type
  // (`friend: UserSummary`, declared non-nullable) and left every
  // downstream consumer — e.g. getBannedFriendsScore's
  // `friendData.friend.nickname` — one bad Steam response away from a
  // null-dereference crash. Dropping unresolvable friends here keeps the
  // type honest end to end, at the cost of occasionally returning fewer
  // than MAX_CLOSE_FRIENDS entries — an accurate reflection of reality
  // (there's no usable data for that friend), not a bug.
  const closestFriendsWithSummary = closestFriends.reduce<
    Array<{ friend: (typeof summariesArray)[number]; count: number }>
  >((acc, friend) => {
    const summary = summariesArray.find(
      (sum) => sum.steamID === friend.steamID,
    );
    if (summary) {
      acc.push({ friend: summary, count: friend.count });
    }
    return acc;
  }, []);

  const droppedCount = closestFriends.length - closestFriendsWithSummary.length;
  if (droppedCount > 0) {
    console.warn(
      `getCloseFriends - ${droppedCount} close friend(s) of ${target} had no resolvable Steam summary and were dropped.`,
    );
  }

  return closestFriendsWithSummary;
};

export async function POST(req: Request) {
  if (req.method === 'POST') {
    let body;
    try {
      body = await req.json();
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
      console.error(
        `getCloseFriends - Internal server Error: ${(error as Error).message}. It was fetching with these params: ${JSON.stringify(body)}`,
        error,
      );
      return NextResponse.json(
        { message: `Internal server Error: ${(error as Error).message}` },
        { status: 500 },
      );
    }
  } else {
    return NextResponse.json({ message: 'Method not allowed.' });
  }
}
