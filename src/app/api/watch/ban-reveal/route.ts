import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import {
  getBanSubscriptionById,
  recordBanRevealClick,
} from '@/lib/analytics/db';
import { resolveWatchSession } from '@/lib/watch/session';
import checkSameOrigin from '@/lib/watch/csrf';

export const runtime = 'nodejs';

export const revalidate = 0;

// State-changing (appends the reveal-click log), so it is POST-only and
// rate-limited like every other watch write path. Per-instance in-memory
// limiter (same accepted residual as the sibling routes).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const revealRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * Ban Reveal click-through (Phase 1): logs a reveal-click event
 * (subscriber, target, timestamp — server-side only) and returns the
 * actual target profile to THAT subscriber.
 *
 * Instrumentation for a future monetization decision, not a monetization
 * feature itself: no gating logic beyond auth (the caller must own the
 * subscription row). The request carries the opaque subscription id from
 * the banAlerts inbox stream — never a target steamId — so one subscriber
 * cannot probe another's rows by guessing ids (a foreign id answers 404,
 * indistinguishable from a missing one).
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (revealRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  // Same second layer as every other authenticated session POST (signup,
  // logout, confirm, resend): SameSite=Lax already blocks third-party
  // POSTs from sending the cookie; the Origin check closes the remainder.
  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('banReveal', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while revealing the profile.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;

  let body: unknown;
  try {
    body = await req.json();
  } catch (error) {
    logRouteError('banReveal', sanitizeError(error), { steamId });
    return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
  }

  const subscriptionId =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>).subscriptionId
      : undefined;
  if (
    typeof subscriptionId !== 'number' ||
    !Number.isInteger(subscriptionId) ||
    subscriptionId <= 0
  ) {
    return errorResponse(
      'Invalid subscriptionId: expected a positive integer.',
      400,
      'INVALID_REQUEST',
    );
  }

  try {
    const subscription = await getBanSubscriptionById(subscriptionId);
    // Auth = must be the subscribing user for that row. Foreign/missing
    // rows share one 404 (no oracle for probing other subscribers' ids).
    if (
      subscription === null ||
      subscription.subscriberSteamId !== steamId
    ) {
      return errorResponse('Subscription not found.', 404, 'NOT_FOUND');
    }

    // Server-side-only instrumentation: never trust a client timestamp.
    try {
      await recordBanRevealClick(steamId, subscription.targetSteamId);
    } catch (error) {
      // A sick reveals table must not block the reveal itself (the click
      // already happened from the user's perspective) — loud log, still 200.
      logRouteError('banReveal:clickLog', error, {
        steamId,
        subscriptionId,
      });
    }

    return NextResponse.json(
      {
        subscriptionId: subscription.id,
        targetSteamId: subscription.targetSteamId,
        notifiedAt: subscription.notifiedAt,
        subscribedAt: subscription.subscribedAt,
      },
      { status: 200, headers: NO_STORE_HEADERS },
    );
  } catch (error) {
    logRouteError('banReveal', sanitizeError(error), {
      steamId,
      subscriptionId,
    });
    return errorResponse(
      'Internal server error while revealing the profile.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
