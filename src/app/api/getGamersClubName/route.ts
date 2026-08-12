import { NextResponse } from 'next/server';
import axios from 'axios';
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

    let gcName: string | null = null;
    const scraperUrl = process.env.LOCAL_PROXY_URL;

    if (scraperUrl) {
      try {
        const cleanedUrl = scraperUrl.replace(/\/$/, '');
        const targetUrl = `${cleanedUrl}/api/gamersclub/${steamId}`;
        const response = await axios.get(targetUrl, {
          timeout: 60000,
        });

        if (response.status === 200 && response.data) {
          gcName = response.data.name;
        }
      } catch (error) {
        console.error(
          `[Local Proxy] External proxy failed for Steam ID ${steamId}:`,
          getErrorMessage(error),
        );
      }
    }

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
