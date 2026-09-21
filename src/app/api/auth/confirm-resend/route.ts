import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import checkSameOrigin from '@/lib/watch/csrf';
import { resolveWatchSession } from '@/lib/watch/session';
import {
  enqueueEvent,
  getAccount,
  getWatchedProfile,
} from '@/lib/analytics/db';

export const runtime = 'nodejs';

export const revalidate = 0;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
// Same cheap-flood budget as signup: resends trigger Steam chat messages,
// so this lane is abuse-adjacent — but correctness never lives here (the
// bot poller re-validates everything and throttles re-issues), only pace.
const resendRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Requests a fresh confirm link for the LOGGED-IN profile (resend flow).
 *
 * Identity comes EXCLUSIVELY from the Steam OpenID session (401 without
 * one); the request carries no body and no parameters — there is nothing
 * to forge. Single-funnel note: signup deliberately never issues tokens
 * (the bot is the sole issuer, so at most one link is ever outstanding);
 * this route preserves that by only ENQUEUEING a `confirm_resend` event —
 * the bot poller (sole issuer alongside the friendship-accept path)
 * validates friendship, confirmation state and throttle, then issues +
 * delivers. A repeat POST while a valid link is outstanding is harmless:
 * the poller drops it as throttled.
 *
 * Idempotent by construction: eligible requests enqueue exactly one row
 * per call, but every row converges to at most one chat message (live
 * tokens suppress re-issues), so double-clicks and retries cannot spam.
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (resendRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('authConfirmResend', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while requesting a new link.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;

  try {
    // Cheap local pre-checks so obvious no-ops never touch the outbox;
    // the bot poller re-validates all of this anyway (defense in depth
    // against races: a click landing between here and fulfillment drops
    // the event as already-confirmed instead of re-issuing over it).
    const [profile, account] = await Promise.all([
      getWatchedProfile(steamId),
      getAccount(steamId),
    ]);
    if (
      profile === null ||
      profile.status !== 'pending' ||
      account === null ||
      account.confirmedAt !== null
    ) {
      return NextResponse.json({ ok: true, queued: false }, { status: 200 });
    }
    await enqueueEvent(steamId, 'confirm_resend');
    return NextResponse.json({ ok: true, queued: true }, { status: 200 });
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('authConfirmResend', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while requesting a new link.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
