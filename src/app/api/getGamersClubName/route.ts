import { NextResponse } from 'next/server';
import axios from 'axios';
import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';

export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const { steamId } = body;

    if (!steamId || typeof steamId !== 'string') {
      return errorResponse(
        'Invalid or missing steamId parameter',
        400,
        'INVALID_REQUEST',
      );
    }

    let gcName: string | null = null;
    const scraperUrl = process.env.LOCAL_PROXY_URL;

    if (scraperUrl) {
      try {
        const cleanedUrl = scraperUrl.replace(/\/$/, '');
        const targetUrl = `${cleanedUrl}/api/gamersclub/${encodeURIComponent(steamId)}`;
        const response = await axios.get(targetUrl, {
          timeout: 60000,
        });

        if (response.status === 200 && response.data) {
          gcName = response.data.name;
        }
      } catch (error) {
        logRouteError('getGamersClubName [local proxy]', error, { steamId });
      }
    }

    return NextResponse.json({ steamId, gcName }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('getGamersClubName', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getGamersClubName', error);
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
