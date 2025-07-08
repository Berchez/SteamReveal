import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI from 'steamapi';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getPlayTimeScore from './utils/playTimeMethod';

export const revalidate = 0;
const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const STEAMREVEAL_API_BASE = process.env.STEAMREVEAL_API_BASE;

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return NextResponse.json(
      { message: 'Method not allowed.' },
      { status: 405 },
    );
  }

  try {
    const body = await req.json();
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
      hltvRatingResponse,
      last5MatchesRatingResponse,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId),
      getBannedFriendsScore(closeFriends),
      getInventoryScore(targetSteamId),
      getPlayTimeScore(targetSteamId),
      steam.getUserLevel(targetSteamId),

      axios
        .get(`${STEAMREVEAL_API_BASE}/hltv-rating/${targetSteamId}`)
        .then((res) => res.data.rating)
        .catch(() => null),

      axios
        .get(`${STEAMREVEAL_API_BASE}/last5-matches-rating/${targetSteamId}`)
        .then((res) => res.data.average)
        .catch(() => null),
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

    const flaskResponse = await axios.post(
      'https://cheater-probability-ai.onrender.com/predict',
      { features },
      {
        headers: {
          'Content-Type': 'application/json',
        },
      },
    );

    const { probability } = flaskResponse.data;

    return NextResponse.json(
      { cheaterProbability: probability, features },
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
