import { NextResponse } from 'next/server';
import axios from 'axios';

/**
 * Attaches a cheater-probability score to a search that was already
 * recorded via /api/recordAnalytics. Called once the user actually
 * requests a cheater report for that search (the score isn't computed
 * for every search, so it can't be sent up front).
 *
 * Path: src/app/api/recordAnalytics/cheater/route.ts
 */

export const revalidate = 0;

const { LOCAL_PROXY_URL } = process.env;

const EIGHT_SECONDS_IN_MS = 8 * 1000;

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return NextResponse.json(
      { message: 'Method not allowed.' },
      { status: 405 },
    );
  }

  let body;
  try {
    const { ANALYTICS_SKIP_PASSWORD } = process.env;
    const skipHeader = req.headers.get('x-analytics-skip-password');
    if (ANALYTICS_SKIP_PASSWORD && skipHeader === ANALYTICS_SKIP_PASSWORD) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    body = await req.json();

    const { searchId, score } = body ?? {};

    if (!searchId || typeof score !== 'number') {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    if (!LOCAL_PROXY_URL) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    await axios.post(`${LOCAL_PROXY_URL}/api/analytics/cheater`, body, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: EIGHT_SECONDS_IN_MS,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    console.error(
      `recordAnalytics/cheater - Internal server Error: ${(error as Error).message}. It was fetching with these params: ${JSON.stringify(body)}`,
      error,
    );
    return NextResponse.json(
      {
        message:
          'Internal server error while updating the cheater probability.',
      },
      { status: 500 },
    );
  }
}
