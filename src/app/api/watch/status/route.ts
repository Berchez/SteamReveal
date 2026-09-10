import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { getWatchStatus } from '@/lib/analytics/db';
import { isSteamId64 } from '@/lib/steamId';

export const runtime = 'nodejs';

export const revalidate = 0;

// Read-only polling endpoint by design (the frontend polls this after
// POST /api/watch/request until the watch flips to active), so the cap is
// looser than the write route's: 30/min supports ~2s-interval polling for
// a few minutes without throttling legitimate use, while still bounding a
// single IP. One indexed PK lookup per hit — cheap by construction.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const statusRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Returns the current watch state for a Steam profile — exclusively one
 * of 'pending' | 'active' | 'none' ('none' covers never-requested AND
 * opted-out/deactivated: both mean "no watch", and the distinction is
 * internal state the API deliberately does not expose).
 *
 * Strictly read-only: no login, no session, no state mutation (the only
 * DAL call is getWatchStatus). Used by the frontend polling loop after a
 * watch request.
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (statusRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const steamId = new URL(req.url).searchParams.get('steamId');
  if (!isSteamId64(steamId)) {
    return errorResponse(
      'Invalid steamId: expected ?steamId=<17-digit SteamID64>.',
      400,
      'INVALID_REQUEST',
    );
  }

  try {
    const status = await getWatchStatus(steamId);
    return NextResponse.json(
      { steamId, status: status ?? 'none' },
      { status: 200 },
    );
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('watchStatus', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while reading watch status.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
