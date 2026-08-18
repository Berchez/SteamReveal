import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI, { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import { isValidCloseFriendItem } from './utils/validateCloseFriends';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getGameLibraryStats from './utils/gameLibraryStatsMethod';
import getCsStats, {
  CS_STATS_FIELD_ORDER,
  assertCsStatsShape,
} from './utils/csStats';
import { clearStat, getAccountAge } from './utils/utils';

export const revalidate = 0;
const steam = new SteamAPI(getSteamApiKey() ?? '');

const { CHEATER_AI_API_BASE } = process.env;

const FIVE_MINS_IN_MS = 5 * 60 * 1000;

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return NextResponse.json(
      { message: 'Method not allowed.' },
      { status: 405 },
    );
  }

  let body;
  try {
    body = await req.json();

    const { closeFriends, target } = body;

    // Reject oversized/malformed payloads before touching Steam API at
    // all.
    //
    // Note: getBannedFriendsScore makes ONE batched call to
    // steam.getUserBans(steamIDs) with the whole array — not one Steam
    // API call per item as originally assumed. The size cap below still
    // matters (it bounds that single call's payload and every per-item
    // computation that follows), but it does NOT by itself neutralize
    // the sharper abuse vector: a single well-formed item with an
    // unbounded `count` can blow up calcBansWeight's
    // `3 ** (bansSum * count)` to Infinity. That is capped separately in
    // isValidCloseFriendItem (see MAX_FRIEND_COUNT there) — the length
    // check here and the per-item shape/bounds check below are both
    // required, neither is sufficient alone.
    //
    // `target` must be a non-empty string — a truthy-but-wrong-typed
    // value (object/array) would otherwise be passed straight to
    // steam.resolve(target).
    if (
      !Array.isArray(closeFriends) ||
      typeof target !== 'string' ||
      target.length === 0 ||
      closeFriends.length > MAX_CLOSE_FRIENDS
    ) {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    // Reject malformed items (bad steamID, bad/unbounded count) before
    // they reach getBannedFriendsScore / calcBansWeight downstream.
    if (!closeFriends.every(isValidCloseFriendItem)) {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    const targetSteamId = await steam.resolve(target);

    const [
      badCommentsScore,
      bannedFriendsResult,
      inventoryScore,
      gameLibraryStats,
      userLevel,
      csStats,
      userSummary,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId),
      getBannedFriendsScore(closeFriends),
      getInventoryScore(targetSteamId),
      getGameLibraryStats(targetSteamId),
      steam.getUserLevel(targetSteamId),
      getCsStats(targetSteamId),
      steam.getUserSummary(targetSteamId),
    ]);

    const { playTime: playTimeScore, totalGamesCount } = gameLibraryStats;

    const { score: bannedFriendsScore, bannedFriendsDetails } =
      bannedFriendsResult;

    const accountAge = getAccountAge(userSummary as UserSummary);

    // Built by explicit field name (CS_STATS_FIELD_ORDER), not
    // Object.values(csStats) — see utils/csStats/index.ts for why. If
    // getCsStats() ever returns an unexpected shape, assertCsStatsShape
    // throws here (→ 500, logged below) instead of silently sending the
    // model a misaligned feature vector.
    if (csStats) {
      assertCsStatsShape(csStats);
    }

    const csStatsFeaturesArr = csStats
      ? CS_STATS_FIELD_ORDER.map((key) => clearStat(csStats[key]))
      : Array(CS_STATS_FIELD_ORDER.length).fill(-1);

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      ...csStatsFeaturesArr,
    ].map((value) => (value === null || value === undefined ? -1 : value));

    const featureObject = {
      badCommentsScore: features[0],
      bannedFriendsScore: features[1],
      inventoryScore: features[2],
      playTimeScore: features[3],
      userLevel: features[4],
      csStats,
      analyzedFriendsCount: closeFriends.length,
      bannedFriendsDetails,
      accountAge,
      totalGamesCount,
    };

    const flaskResponse = await axios.post(
      `${CHEATER_AI_API_BASE}/predict`,
      { features },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: FIVE_MINS_IN_MS,
      },
    );

    const { probability } = flaskResponse.data;

    return NextResponse.json(
      { cheaterProbability: probability, featureObject },
      { status: 200 },
    );
  } catch (error) {
    console.error(
      `getCheaterProbability - Internal server Error: ${(error as Error).message}. It was fetching with these params: ${JSON.stringify(body)}`,
      error,
    );
    return NextResponse.json(
      { message: 'Internal server error while querying the prediction model.' },
      { status: 500 },
    );
  }
}
