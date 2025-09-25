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

const clearStat = (stat: string) => {
  return stat.replace('ms', '').replace('%', '');
};

export async function POST(req: Request) {
  console.log('[POST] Request received');

  if (req.method !== 'POST') {
    console.warn('[POST] Method not allowed:', req.method);
    return NextResponse.json(
      { message: 'Method not allowed.' },
      { status: 405 },
    );
  }

  try {
    const body = await req.json();
    console.log('[POST] Request body:', body);

    const { closeFriends, target } = body;

    if (!Array.isArray(closeFriends) || !target) {
      console.warn('[POST] Invalid request body.', body);
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    console.log('[POST] Resolving Steam ID for target:', target);
    const targetSteamId = await steam.resolve(target);
    console.log('[POST] Resolved Steam ID:', targetSteamId);

    console.log('[POST] Fetching features in parallel...');

    const [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      csStats,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId).then((r) => {
        console.log('[POST] badCommentsScore:', r);
        return r;
      }),
      getBannedFriendsScore(closeFriends).then((r) => {
        console.log('[POST] bannedFriendsScore:', r);
        return r;
      }),
      getInventoryScore(targetSteamId).then((r) => {
        console.log('[POST] inventoryScore:', r);
        return r;
      }),
      getPlayTimeScore(targetSteamId).then((r) => {
        console.log('[POST] playTimeScore:', r);
        return r;
      }),
      steam.getUserLevel(targetSteamId).then((r) => {
        console.log('[POST] userLevel:', r);
        return r;
      }),
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

    console.log('[POST] Features array:', features);

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

    console.log('[POST] Flask response:', flaskResponse.data);

    const { probability } = flaskResponse.data;

    console.log('[POST] Returning result:', { probability, featureObject });

    return NextResponse.json(
      { cheaterProbability: probability, featureObject },
      { status: 200 },
    );
  } catch (error) {
    console.error('Error in cheater probability calculation:', error);
    return NextResponse.json(
      { message: 'Internal server error while querying the prediction model.' },
      { status: 500 },
    );
  }
}
