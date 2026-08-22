import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import isValidTargetParam from '@/lib/isValidTargetParam';
import { errorResponse } from '@/lib/apiError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
import isSteamUnauthorizedError from '@/lib/isSteamUnauthorizedError';

export const revalidate = 0;

const steamApiKey = getSteamApiKey();
if (!steamApiKey) {
  console.error(
    'getCloseFriends - STEAM_API_KEY is missing at module init. Every request to this route will fail until it is set.',
  );
}
const steam = new SteamAPI(steamApiKey ?? '');

const STEAM_CALL_TIMEOUT_MS = 8000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

type UserFriend = {
  steamID: string;
  friendedTimestamp: number;
  relationship: string;
};

const getFriendsOfFriends = async (friendList: Array<UserFriend>) => {
  const friendsOfFriends: Array<UserFriend> = [];
  await Promise.all(
    friendList.map(async (friend: UserFriend) => {
      try {
        const list = await withTimeout(
          steam.getUserFriends(friend.steamID),
          `getCloseFriends: steam.getUserFriends(${friend.steamID})`,
          STEAM_CALL_TIMEOUT_MS,
        );
        friendsOfFriends.push(...list);
      } catch (error) {
        console.warn(
          `getCloseFriends - failed to get friends of friend ${friend.steamID}:`,
          error,
        );
      }
    }),
  );

  return friendsOfFriends;
};

const getCloseFriends = async (target: string) => {
  let friendsOfTheTarget: UserFriend[];
  try {
    friendsOfTheTarget = (
      await withTimeout(
        steam.getUserFriends(target),
        'getCloseFriends: steam.getUserFriends(target)',
        STEAM_CALL_TIMEOUT_MS,
      )
    ).slice(0, 100);
  } catch (err) {
    if (err instanceof SteamCallTimeoutError) {
      throw err;
    }
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
  // validation (see @/lib/closeFriendsLimits). This is the place that
  // actually decides how many close friends the product considers; that
  // other route just caps what it'll accept back from the client at the
  // same number. Change it in one place, both stay in sync.
  const closestFriends = closeFriendsOfTheTarget.slice(0, MAX_CLOSE_FRIENDS);

  const steamIDs = closestFriends.map((friend) => friend.steamID);

  const summaries = await withTimeout(
    steam.getUserSummary(steamIDs),
    'getCloseFriends: steam.getUserSummary(closestFriends)',
    STEAM_CALL_TIMEOUT_MS,
  );
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
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  const ip = getRequestIp(req);
  if (rateLimiter.isRateLimited(ip)) {
    return errorResponse(
      'Too many requests. Try again later.',
      429,
      'RATE_LIMITED',
    );
  }

  let body;
  try {
    body = await req.json();
    const { target } = body;

    if (!isValidTargetParam(target)) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    const targetSteamId = await withTimeout(
      steam.resolve(target),
      'getCloseFriends: steam.resolve',
      STEAM_CALL_TIMEOUT_MS,
    );
    const targetCloseFriends = await getCloseFriends(targetSteamId);

    return NextResponse.json(
      { closeFriends: targetCloseFriends },
      { status: 200 },
    );
  } catch (error) {
    if (isSteamUnauthorizedError(error)) {
      console.warn(
        `getCloseFriends - target's data is private: ${req.url}`,
        error,
      );
      return errorResponse(
        "Target's friends list is private or inaccessible.",
        400,
        'INVALID_REQUEST',
      );
    }

    if (error instanceof SyntaxError) {
      logRouteError('getCloseFriends', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    if (error instanceof SteamCallTimeoutError) {
      logRouteError('getCloseFriends', error, { body });
      return errorResponse(
        'Steam API request timed out. Please try again.',
        504,
        'TIMEOUT',
      );
    }

    if (isSteamResolveFormatError(error)) {
      logRouteError('getCloseFriends', error, { target: req.url });
      return errorResponse('Invalid target format.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getCloseFriends', error, { body });
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
