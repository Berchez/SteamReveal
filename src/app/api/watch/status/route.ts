import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { getAccount, getWatchStatus } from '@/lib/analytics/db';
import { resolveWatchSession } from '@/lib/watch/session';

export const runtime = 'nodejs';

export const revalidate = 0;

// Read-only polling endpoint by design (the frontend polls this after
// POST /api/auth/signup until the watch flips to active), so the cap is
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
 * Whether the profile's confirm link died unclicked (drives the resend
 * UI). True only for a REAL past expiry on an unconfirmed account —
 * missing rows, confirmed accounts and corrupt clocks all read false (an
 * unparseable expiry fails closed toward "not expired": the resend button
 * stays hidden rather than offering a resend for a state we cannot read).
 * Display-only: a transient read failure degrades to false (logged
 * loudly) instead of 500ing the polling loop over garnish.
 */
const readConfirmExpired = async (steamId: string): Promise<boolean> => {
  try {
    const account = await getAccount(steamId);
    return (
      account !== null &&
      account.confirmedAt === null &&
      account.confirmExpiresAt !== null &&
      Date.parse(account.confirmExpiresAt) <= Date.now()
    );
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('watchStatus:confirmExpired', sanitizeError(error), {
      steamId,
    });
    return false;
  }
};

/**
 * Returns the current watch state for the LOGGED-IN profile — exclusively
 * one of 'pending' | 'active' | 'none' ('none' covers never-requested AND
 * opted-out/deactivated: both mean "no watch", and the distinction is
 * internal state the API deliberately does not expose).
 *
 * Plus `confirmExpired`: whether the confirm link died unclicked (drives
 * the resend UI). True only for a REAL past expiry on an unconfirmed
 * account — missing rows, confirmed accounts and corrupt clocks all read
 * false. Display-only like the confirm route's locale read: a transient
 * failure degrades to false (logged loudly) instead of 500ing the polling
 * loop over garnish.
 *
 * Self-scoped: identity comes EXCLUSIVELY from the Steam OpenID session —
 * the old `?steamId=` parameter is gone entirely (a present-but-ignored
 * id would be a third-party lookup footgun, so its presence is a 400).
 * Unauthenticated callers get 401.
 *
 * Strictly read-only: no state mutation (the only DAL calls are
 * getWatchStatus + getAccount). Used by the frontend polling loop after a
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

  if (new URL(req.url).searchParams.has('steamId')) {
    return errorResponse(
      'Invalid request: steamId comes from the login session, not the query string.',
      400,
      'INVALID_REQUEST',
    );
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('watchStatus', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while reading watch status.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;

  try {
    const status = await getWatchStatus(steamId);
    const confirmExpired = status === 'pending' ? await readConfirmExpired(steamId) : false;
    return NextResponse.json(
      {
        steamId,
        status: status ?? 'none',
        confirmExpired,
      },
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
