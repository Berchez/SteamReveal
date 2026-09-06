import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { recordSearch } from '@/lib/analytics/db';
import { parseRecordBody } from '@/app/api/analytics/input';
import redactBodyForLog from '@/app/api/analytics/redactBody';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const writeRateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

/**
 * Records a finished search straight into the Turso analytics DB.
 *
 * This used to forward to the local proxy via LOCAL_PROXY_URL, which only
 * happened because the store was a local file. The storage is Turso now
 * (DATABASE_URL/DATABASE_TOKEN), so the write happens here, inside the
 * Vercel function itself — the proxy's /api/analytics/* endpoints have been
 * retired.
 *
 * Best-effort: without DATABASE_URL (e.g. an env that lacks Turso) it
 * returns the same `{ id: null, skipped: true }` shape as before, so
 * callers never mistake a skip for a real record id.
 *
 * Path: src/app/api/recordAnalytics/route.ts
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
    // A validated skip is owner-invoked (it requires sharing the skip secret)
    // and does no DB writes — check it BEFORE the public per-IP write cap so a
    // heavy owner session never 429s itself. An invalid password falls through
    // to the limiter below, so brute-forcing the secret stays throttled.
    const skipHeader = req.headers.get('x-analytics-skip-password');
    if (
      process.env.ANALYTICS_SKIP_PASSWORD &&
      skipHeader !== null &&
      timingSafeEqualStrings(skipHeader, process.env.ANALYTICS_SKIP_PASSWORD)
    ) {
      // Keep the same shape as the "no DATABASE_URL" skip below —
      // `id: null` so callers never mistake a skip for a real record id.
      return NextResponse.json({ id: null, skipped: true }, { status: 200 });
    }

    // Public endpoint (the client posts fire-and-forget), so cap writes per IP:
    // one search emits 1-3 records, and 30/min is far above that. Cheap cost
    // abatement against a Turso row-write bill.
    if (writeRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    const { DATABASE_URL } = process.env;
    body = await req.json();

    if (!DATABASE_URL) {
      // Analytics is best-effort: without Turso configured we just skip
      // recording instead of failing the search.
      return NextResponse.json({ id: null, skipped: true }, { status: 200 });
    }

    const input = parseRecordBody(body);
    if (!input) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    const record = await recordSearch(input);

    // `id` lets the client attach a cheater-probability score to this same
    // search later, via /api/recordAnalytics/cheater.
    return NextResponse.json({ ok: true, id: record.id }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('recordAnalytics', sanitizeError(error));
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('recordAnalytics', sanitizeError(error), {
      body: redactBodyForLog(body),
    });
    return errorResponse(
      'Internal server error while recording analytics.',
      500,
      'INTERNAL_ERROR',
    );
  }
}