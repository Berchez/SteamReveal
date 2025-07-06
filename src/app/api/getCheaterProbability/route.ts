import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI from 'steamapi';
import getHLTVRating from './utils/hltvRatingMethod';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getLast5MatchesRating from './utils/last5MatchesMethod';
import getPlayTimeScore from './utils/playTimeMethod';

export const revalidate = 0;
const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

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
      hltvRating,
      inventoryScore,
      last5MatchesRating,
      playTimeScore,
      userLevel,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId),
      getBannedFriendsScore(closeFriends),
      getHLTVRating(targetSteamId),
      getInventoryScore(targetSteamId),
      getLast5MatchesRating(targetSteamId),
      getPlayTimeScore(targetSteamId),
      steam.getUserLevel(targetSteamId),
    ]);

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      hltvRating,
      inventoryScore,
      last5MatchesRating,
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
