import { NextResponse } from 'next/server';
import scrapeGamersClubName from './utils/scrapeGamersClubName';
import applyRateLimit from './utils/rateLimit';
import getErrorMessage from './utils/getErrorMessage';

export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { steamId } = body;

    if (!steamId || typeof steamId !== 'string') {
      return NextResponse.json(
        { message: 'Invalid or missing steamId parameter' },
        { status: 400 },
      );
    }

    // Serialize requests to GamersClub to avoid tripping their rate limit
    await applyRateLimit();

    const gcName = await scrapeGamersClubName(steamId);

    return NextResponse.json({ steamId, gcName }, { status: 200 });
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(
      `getGamersClubName - Internal server error: ${message}`,
      error,
    );

    return NextResponse.json(
      { message: `Internal server error: ${message}` },
      { status: 500 },
    );
  }
}
