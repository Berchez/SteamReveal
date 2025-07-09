import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI from 'steamapi';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getPlayTimeScore from './utils/playTimeMethod';

export const revalidate = 0;
const steam = new SteamAPI(process.env.STEAM_API_KEY ?? '');

const { STEAMREVEAL_API_BASE } = process.env;

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

    console.log('[DEBUG] Request body:', body);

    if (!Array.isArray(closeFriends) || !target) {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    console.log('[DEBUG] Resolving SteamID...');
    const targetSteamId = await steam.resolve(target);
    console.log('[DEBUG] SteamID resolved:', targetSteamId);

    console.log('[DEBUG] Starting feature extraction...');

    const [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      hltvRatingResponse,
      last5MatchesRatingResponse,
    ] = await Promise.all([
      (async () => {
        console.log('[DEBUG] getBadCommentsScore...');
        const r = await getBadCommentsScore(targetSteamId);
        console.log('[DEBUG] getBadCommentsScore OK');
        return r;
      })(),

      (async () => {
        console.log('[DEBUG] getBannedFriendsScore...');
        const r = await getBannedFriendsScore(closeFriends);
        console.log('[DEBUG] getBannedFriendsScore OK');
        return r;
      })(),

      (async () => {
        console.log('[DEBUG] getInventoryScore...');
        const r = await getInventoryScore(targetSteamId);
        console.log('[DEBUG] getInventoryScore OK');
        return r;
      })(),

      (async () => {
        console.log('[DEBUG] getPlayTimeScore...');
        const r = await getPlayTimeScore(targetSteamId);
        console.log('[DEBUG] getPlayTimeScore OK');
        return r;
      })(),

      (async () => {
        console.log('[DEBUG] getUserLevel...');
        const r = await steam.getUserLevel(targetSteamId);
        console.log('[DEBUG] getUserLevel OK');
        return r;
      })(),

      (async () => {
        try {
          console.log('[DEBUG] Calling /hltv-rating...');
          const res = await axios.get(
            `${STEAMREVEAL_API_BASE}/hltv-rating/${targetSteamId}`,
            {
              timeout: 15000,
            },
          );
          console.log('[DEBUG] /hltv-rating OK');
          return res.data.rating;
        } catch (err) {
          console.error('[ERROR] /hltv-rating failed', err);
          return null;
        }
      })(),

      (async () => {
        try {
          console.log('[DEBUG] Calling /last5-matches-rating...');
          const res = await axios.get(
            `${STEAMREVEAL_API_BASE}/last5-matches-rating/${targetSteamId}`,
            {
              timeout: 15000,
            },
          );
          console.log('[DEBUG] /last5-matches-rating OK');
          return res.data.average;
        } catch (err) {
          console.error('[ERROR] /last5-matches-rating failed', err);
          return null;
        }
      })(),
    ]);

    console.log('[DEBUG] Features extracted');

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      hltvRatingResponse,
      inventoryScore,
      last5MatchesRatingResponse,
      playTimeScore,
      userLevel,
    ].map((value) => value ?? -1);

    console.log('[DEBUG] Calling Flask API with features:', features);

    const flaskResponse = await axios.post(
      'https://cheater-probability-ai.onrender.com/predict',
      { features },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: 15000, // importante!
      },
    );

    const { probability } = flaskResponse.data;

    console.log('[DEBUG] Flask response:', probability);

    return NextResponse.json(
      { cheaterProbability: probability, features },
      { status: 200 },
    );
  } catch (error) {
    console.error('❌ Error in cheater probability calculation:', error);
    return NextResponse.json(
      { message: 'Internal server error while querying the prediction model.' },
      { status: 500 },
    );
  }
}
