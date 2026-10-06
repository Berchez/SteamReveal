import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { recordLoginFunnelEvent, recordLoginPopupEvent } from '@/lib/analytics/db';
import { parseLoginFunnelBody } from '@/app/api/analytics/input';
import { malformedBodyResponse } from '@/app/api/analytics/malformedBody';
import redactBodyForLog from '@/app/api/analytics/redactBody';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const writeRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Records Steam-login funnel beacons: the navbar `login_cta_clicked` step
 * plus the login-prompt popup steps (`login_popup_shown`,
 * `login_popup_cta_clicked`). Fired fire-and-forget client-side, never
 * awaited.
 *
 * Writes straight to Turso (DATABASE_URL/DATABASE_TOKEN), same as the
 * other recordAnalytics* routes — no proxy forward.
 *
 * ONLY the client-reportable step is accepted here: a forged
 * `login_completed` from the browser would let anyone fake conversions,
 * so completions enter exclusively server-side (completeProvenLogin →
 * DAL, keyed by the CTA cookie). The parser allowlists the single event.
 *
 * Path: src/app/api/recordAnalyticsLogin/route.ts
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

    // Same public-endpoint write cap as the sibling routes — a login click
    // emits at most one beacon, so 30/min per IP is generous headroom.
    if (writeRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    const { DATABASE_URL } = process.env;
    // Isolated parse (see recordAnalytics): only req.json() failures take
    // the benign-noise 400+warn.
    try {
      body = await req.json();
    } catch (parseError) {
      return malformedBodyResponse('recordAnalytics/login', parseError);
    }

    if (!DATABASE_URL) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    const parsed = parseLoginFunnelBody(body);
    if (!parsed) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    // One route, two tables: the parser allowlists only client-reportable
    // steps, and the DAL branches by event (popup steps land in
    // login_popup_events, never in the navbar funnel table).
    if (
      parsed.event === 'login_popup_shown' ||
      parsed.event === 'login_popup_cta_clicked'
    ) {
      await recordLoginPopupEvent({
        event: parsed.event,
        sessionId: parsed.sessionId,
        searchId: parsed.searchId,
      });
    } else {
      await recordLoginFunnelEvent({
        event: parsed.event,
        sessionId: parsed.sessionId,
        searchId: parsed.searchId,
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logRouteError('recordAnalytics/login', sanitizeError(error), {
      body: redactBodyForLog(body),
    });
    return errorResponse(
      'Internal server error while recording the login event.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
