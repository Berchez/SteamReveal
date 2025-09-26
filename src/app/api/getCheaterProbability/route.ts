import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI from 'steamapi';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getPlayTimeScore from './utils/playTimeMethod';
import getCsStats from './utils/csStats';

export const revalidate = 0;
const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const { CHEATER_AI_API_BASE } = process.env;

const FIVE_MINS_IN_MS = 5 * 60 * 1000;

const clearStat = (stat: string) => stat.replace('ms', '').replace('%', '');
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

    if (!Array.isArray(closeFriends) || !target) {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    const targetSteamId = await steam.resolve(target);

    const [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      csStats,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId),
      getBannedFriendsScore(closeFriends),
      getInventoryScore(targetSteamId),
      getPlayTimeScore(targetSteamId),
      steam.getUserLevel(targetSteamId),
      getCsStats(targetSteamId),
    ]);

    const csStatsFeaturesArr = csStats
      ? Object.values(csStats).map(clearStat)
      : [];

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      ...csStatsFeaturesArr,
    ].map((value) => value ?? -1);

    const featureObject = {
      badCommentsScore: features[0],
      bannedFriendsScore: features[1],
      inventoryScore: features[2],
      playTimeScore: features[3],
      userLevel: features[4],
      csStats,
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
