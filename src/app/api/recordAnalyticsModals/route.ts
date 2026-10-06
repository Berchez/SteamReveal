import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { recordModalEvent } from '@/lib/analytics/db';
import { parseModalEventBody } from '@/app/api/analytics/input';
import { malformedBodyResponse } from '@/app/api/analytics/malformedBody';
import redactBodyForLog from '@/app/api/analytics/redactBody';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const writeRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Records promo-modal engagement beacons: SponsorMe / SupportMe /
 * login-prompt, each reporting shown / cta_clicked / closed / dismissed.
 * Fired fire-and-forget client-side, never awaited.
 *
 * Writes straight to Turso (DATABASE_URL/DATABASE_TOKEN), same as the
 * other recordAnalytics* routes — no proxy forward.
 *
 * The parser allowlists only the known modal × event pairs — anything
 * else is a 400, so a hostile client can't invent modals or steps.
 *
 * Path: src/app/api/recordAnalyticsModals/route.ts
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
    // Mirrors recordAnalytics/recordAnalyticsCheater: validated skips are
    // owner-invoked and do no writes, so they bypass the public write cap;
    // invalid passwords still reach the limiter below.
    const skipHeader = req.headers.get('x-analytics-skip-password');
    if (
      process.env.ANALYTICS_SKIP_PASSWORD &&
      skipHeader !== null &&
      timingSafeEqualStrings(skipHeader, process.env.ANALYTICS_SKIP_PASSWORD)
    ) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    // Same public-endpoint write cap as the sibling routes — one modal
    // interaction emits at most one beacon, so 30/min per IP is generous
    // headroom.
    if (writeRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    const { DATABASE_URL } = process.env;
    // Isolated parse (see recordAnalytics): only req.json() failures take
    // the benign-noise 400+warn.
    try {
      body = await req.json();
    } catch (parseError) {
      return malformedBodyResponse('recordAnalytics/modals', parseError);
    }

    if (!DATABASE_URL) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    const parsed = parseModalEventBody(body);
    if (!parsed) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    await recordModalEvent({
      modal: parsed.modal,
      event: parsed.event,
    });

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logRouteError('recordAnalytics/modals', sanitizeError(error), {
      body: redactBodyForLog(body),
    });
    return errorResponse(
      'Internal server error while recording the modal event.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
