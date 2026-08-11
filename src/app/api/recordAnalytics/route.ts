import { NextResponse } from 'next/server';
import axios from 'axios';
import getErrorMessage from '../getGamersClubName/utils/getErrorMessage';

export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { profile, friends } = body;

    if (!profile || typeof profile.steamId !== 'string') {
      return NextResponse.json(
        { message: 'Invalid or missing profile.steamId' },
        { status: 400 },
      );
    }

    const scraperUrl = process.env.LOCAL_PROXY_URL;

    if (scraperUrl) {
      try {
        const cleanedUrl = scraperUrl.replace(/\/$/, '');
        await axios.post(
          `${cleanedUrl}/api/analytics/record`,
          { profile, friends: Array.isArray(friends) ? friends : [] },
          { timeout: 8000 },
        );
      } catch (error) {
        console.error(
          `[Analytics] Failed to reach local proxy for Steam ID ${profile.steamId}:`,
          getErrorMessage(error),
        );
      }
    }

    // Always 200: analytics is best-effort, the caller shouldn't retry or surface an error.
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    const message = getErrorMessage(error);
    console.error(`recordAnalytics - Internal server error: ${message}`, error);

    return NextResponse.json(
      { message: `Internal server error: ${message}` },
      { status: 500 },
    );
  }
}