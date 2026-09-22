import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { attachCheaterProbability } from '@/lib/analytics/db';
import { subscribeBanWatcher } from '@/lib/analytics/banWatchSubscribe';
import { resolveWatchSession } from '@/lib/watch/session';
import withTimeout from '@/lib/withTimeout';
import { parseCheaterBody } from '@/app/api/analytics/input';
import redactBodyForLog from '@/app/api/analytics/redactBody';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const writeRateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

/**
 * Attaches a cheater-probability score to a search already recorded via
 * /api/recordAnalytics. Called once the user actually requests a cheater
 * report for that search (the score isn't computed for every search, so it
 * can't be sent up front).
 *
 * Writes straight to Turso (DATABASE_URL/DATABASE_TOKEN), same as
 * recordAnalytics — no proxy forward anymore.
 *
 * Ban Reveal hook (Phase 1): after the score lands, a logged-in reviewer's
 * session subscribes them to a future ban alert on the REVIEWED profile
 * (subscribeBanWatcher — server-side, at the write, never from client
 * input; anonymous reviewers are a no-op). Awaited deliberately (Next 14.2
 * has no after()/waitUntil; a floating promise may die on serverless) and
 * never allowed to fail the cheater write.
 *
 * Path: src/app/api/recordAnalyticsCheater/route.ts
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

    // Same public-endpoint write cap as recordAnalytics — a session emits this
    // at most once per search, so 30/min per IP is generous headroom.
    if (writeRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    const { DATABASE_URL } = process.env;
    body = await req.json();

    if (!DATABASE_URL) {
      return NextResponse.json({ skipped: true }, { status: 200 });
    }

    const parsed = parseCheaterBody(body);
    if (!parsed) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    const updated = await attachCheaterProbability(parsed.searchId, {
      score: parsed.score,
      bannedFriendsCount: parsed.bannedFriendsCount,
      computedAt: new Date().toISOString(),
    });

    if (!updated) {
      return errorResponse(
        'Search record not found for that searchId.',
        404,
        'NOT_FOUND',
      );
    }

    // Ban Reveal subscribe (Phase 1): only when a login session exists —
    // anonymous cheater opens change nothing. Session/target resolution
    // failures degrade to a loud log, never to a failed cheater write.
    // Watchdogged like every other Steam/DB-adjacent wait in this codebase
    // (8s class: isBotFriend, Steam calls): try/catch guards errors, NOT
    // slowness — without this a stalled Turso write would hang the whole
    // cheater-report POST (and the UI opening it) until the serverless
    // timeout. withTimeout only stops OUR wait (the idempotent subscribe
    // may still land late in the background — harmless by construction).
    // Known latency coupling (explicit trade-off, monitor post-deploy):
    // this route previously touched no external network; it now awaits a
    // few indexed reads plus, for never-swept targets only, one live
    // GetPlayerBans (4s inner budget). Worst case ≈ 8s (the watchdog above)
    // when the ban-watch subsystem stalls — watch for
    // 'recordAnalyticsCheater:banWatch timed out' lines in the ops log as
    // the signal that the coupling is biting.
    try {
      const session = await resolveWatchSession(cookies());
      if (session.status === 'authenticated') {
        await withTimeout(
          subscribeBanWatcher(session.steamId, parsed.searchId, {
            error: (message: string) =>
              logRouteError('recordAnalytics/cheater:banWatch', message, {
                searchId: parsed.searchId,
              }),
          }),
          'recordAnalyticsCheater:banWatch',
          8000,
        ).catch((error: unknown) => {
          logRouteError(
            'recordAnalytics/cheater:banWatch',
            sanitizeError(error),
            { searchId: parsed.searchId },
          );
        });
      } else if (session.status === 'error') {
        logRouteError(
          'recordAnalytics/cheater:banWatch',
          sanitizeError(session.error),
          { searchId: parsed.searchId },
        );
      }
    } catch (error) {
      logRouteError('recordAnalytics/cheater:banWatch', sanitizeError(error), {
        searchId: parsed.searchId,
      });
    }

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('recordAnalytics/cheater', sanitizeError(error));
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('recordAnalytics/cheater', sanitizeError(error), {
      body: redactBodyForLog(body),
    });
    return errorResponse(
      'Internal server error while updating the cheater probability.',
      500,
      'INTERNAL_ERROR',
    );
  }
}