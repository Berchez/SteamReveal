import { NextResponse } from 'next/server';
import axios from 'axios';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';

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
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  let body;
  try {
    const { ANALYTICS_SKIP_PASSWORD } = process.env;
    const skipHeader = req.headers.get('x-analytics-skip-password');
    if (
      ANALYTICS_SKIP_PASSWORD &&
      skipHeader !== null &&
      timingSafeEqualStrings(skipHeader, ANALYTICS_SKIP_PASSWORD)
    ) {
      // Keep the same shape as the "no LOCAL_PROXY_URL" skip below —
      // `id: null` so callers never mistake a skip for a real record id.
      return NextResponse.json({ id: null, skipped: true }, { status: 200 });
    }

    body = await req.json();

    const { profile } = body ?? {};

    if (!profile || !profile.steamId) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
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
    if (error instanceof SyntaxError) {
      logRouteError('recordAnalytics', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('recordAnalytics', error, { body });
    return errorResponse(
      'Internal server error while recording analytics.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
