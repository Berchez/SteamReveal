import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI from 'steamapi';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getPlayTimeScore from './utils/playTimeMethod';

export const revalidate = 0;
const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const { STEAMREVEAL_API_BASE, CHEATER_AI_API_BASE } = process.env;

const THREE_MINS_IN_MS = 180 * 1000;

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
      hltvRatingResponse,
      last5MatchesRatingResponse,
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
      axios
        .get(`${STEAMREVEAL_API_BASE}/hltv-rating/${targetSteamId}`, {
          timeout: THREE_MINS_IN_MS,
        })
        .then((res) => {
          console.log('[POST] hltvRatingResponse:', res.data.rating);
          return res.data.rating;
        })
        .catch((err) => {
          console.error('[POST] HLTV rating fetch failed:', err);
          return null;
        }),
      axios
        .get(`${STEAMREVEAL_API_BASE}/last5-matches-rating/${targetSteamId}`, {
          timeout: THREE_MINS_IN_MS,
        })
        .then((res) => {
          console.log('[POST] last5MatchesRatingResponse:', res.data.average);
          return res.data.average;
        })
        .catch((err) => {
          console.error('[POST] Last 5 matches rating fetch failed:', err);
          return null;
        }),
    ]);

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      hltvRatingResponse,
      inventoryScore,
      last5MatchesRatingResponse,
      playTimeScore,
      userLevel,
    ].map((value) => value ?? -1);

    console.log('[POST] Features array:', features);

    const flaskResponse = await axios.post(
      `${CHEATER_AI_API_BASE}/predict`,
      { features },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: THREE_MINS_IN_MS,
      },
    );

    console.log('[POST] Flask response:', flaskResponse.data);

    const { probability } = flaskResponse.data;

    const featureObject = {
      badCommentsScore: features[0],
      bannedFriendsScore: features[1],
      hltvRatingResponse: features[2],
      inventoryScore: features[3],
      last5MatchesRatingResponse: features[4],
      playTimeScore: features[5],
      userLevel: features[6],
    };

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
