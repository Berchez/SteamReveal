import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { attachFriendGcNames } from '@/lib/analytics/db';
import { parseFriendGcNamesBody } from '@/app/api/analytics/input';
import redactBodyForLog from '@/app/api/analytics/redactBody';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const writeRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Backfills friends.gc_name for a search already recorded via
 * /api/recordAnalytics.
 *
 * The friend cards resolve each GC name AFTER the search data lands (each
 * card fetches via /api/getGamersClubName post-render), so the initial
 * analytics payload can only carry gcName: null. This route fills those nulls
 * best-effort a few seconds later with the names the UI actually resolved.
 * Writes straight to Turso (DATABASE_URL/DATABASE_TOKEN), same as
 * recordAnalytics — no proxy forward.
 *
 * Only CONFIRMED names are accepted by the parser; a null/ambiguous scrape
 * result is never sent, so a bad page must not burn a prior known name.
 *
 * Path: src/app/api/recordAnalyticsFriends/route.ts
 */

export const revalidate = 0;

// Remote Turso URLs (libsql://, https://) use @libsql/client's pure-JS hrana
// transport — no native binary is loaded on this path. It still assumes the
// full Node server (WebSocket/fetch, real I/O), so keep `runtime = 'nodejs'`.
export const runtime = 'nodejs';

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  let body;
  try {
    // Mirrors recordAnalytics: validated skips are owner-invoked and do no
    // writes, so they bypass the public write cap; invalid passwords still
    // reach the limiter below, keeping brute-force throttled.
    const skipHeader = req.headers.get('x-analytics-skip-password');
    if (
      process.env.ANALYTICS_SKIP_PASSWORD &&
      skipHeader !== null &&
      timingSafeEqualStrings(skipHeader, process.env.ANALYTICS_SKIP_PASSWORD)
    ) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    // Same public-endpoint write cap as the other analytics routes.
    if (writeRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    const { DATABASE_URL } = process.env;
    body = await req.json();

    if (!DATABASE_URL) {
      // Analytics is best-effort: without Turso configured we just skip.
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    const parsed = parseFriendGcNamesBody(body);
    if (!parsed) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    if (parsed.gcNames.length === 0) {
      // Nothing to write — the client only posts when it has names, but a
      // race can empty the batch; treat it as a successful no-op.
      return NextResponse.json({ ok: true, updated: 0 }, { status: 200 });
    }

    const { searchExists, updated } = await attachFriendGcNames(
      parsed.searchId,
      parsed.gcNames,
    );

    if (!searchExists) {
      return errorResponse(
        'Search record not found for that searchId.',
        404,
        'NOT_FOUND',
      );
    }

    return NextResponse.json({ ok: true, updated }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('recordAnalyticsFriends', sanitizeError(error));
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('recordAnalyticsFriends', sanitizeError(error), {
      body: redactBodyForLog(body),
    });
    return errorResponse(
      'Internal server error while backfilling friend GC names.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
