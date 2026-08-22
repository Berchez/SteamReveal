import { NextResponse } from 'next/server';
import axios from 'axios';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';

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
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    body = await req.json();

    const { searchId, score } = body ?? {};

    if (!searchId || typeof score !== 'number') {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
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
    if (error instanceof SyntaxError) {
      logRouteError('recordAnalytics/cheater', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('recordAnalytics/cheater', error, { body });
    return errorResponse(
      'Internal server error while updating the cheater probability.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
