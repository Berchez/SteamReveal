import { NextResponse } from 'next/server';
import axios from 'axios';

/**
 * Forwards a finished search to the local GamersClub/analytics proxy
 * (reached through the same Cloudflare Tunnel documented in
 * GAMERSCLUB_PROXY.md, via LOCAL_PROXY_URL), which appends it to
 * analytics.html.
 *
 * Path: src/app/api/recordAnalytics/route.ts
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
    body = await req.json();

    const { profile } = body ?? {};

    if (!profile || !profile.steamId) {
      return NextResponse.json(
        { message: 'Invalid request body.' },
        { status: 400 },
      );
    }

    if (!LOCAL_PROXY_URL) {
      // Analytics is best-effort: without the local proxy/tunnel running
      // (e.g. local dev) we just skip recording instead of failing the search.
      return NextResponse.json({ id: null, skipped: true }, { status: 200 });
    }

    const proxyResponse = await axios.post(
      `${LOCAL_PROXY_URL}/api/analytics/record`,
      body,
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: EIGHT_SECONDS_IN_MS,
      },
    );

    const { id } = proxyResponse.data;

    // `id` lets the client attach a cheater-probability score to this same
    // search later, via /api/recordAnalytics/cheater.
    return NextResponse.json({ id: id ?? null }, { status: 200 });
  } catch (error) {
    console.error(
      `recordAnalytics - Internal server Error: ${(error as Error).message}. It was fetching with these params: ${JSON.stringify(body)}`,
      error,
    );
    return NextResponse.json(
      { message: 'Internal server error while recording analytics.' },
      { status: 500 },
    );
  }
}
