import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { destroyWatchSession } from '@/lib/watch/session';
import checkSameOrigin from '@/lib/watch/csrf';

export const runtime = 'nodejs';

export const revalidate = 0;

// Generous per-IP cap (repo convention: every route has one, and logout
// is no exception). Legitimate use is ~1 hit per logout; the cap only
// sheds floods against a cookie-destroying endpoint.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const logoutRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Ends the watch session (replaces the old "forget this browser" local
 * button). CSRF-guarded like every authenticated POST: the SameSite=Lax
 * cookie already blocks third-party sends, the Origin check is the second
 * layer. Always 200 on a handled request — logging out twice is an answer,
 * not an error.
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (logoutRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  try {
    await destroyWatchSession(cookies());
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logRouteError('authLogout', sanitizeError(error));
    return errorResponse(
      'Internal server error while logging out.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
