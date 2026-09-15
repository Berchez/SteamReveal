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
 * Confirm-link state for the resend UI, read from the signup account row.
 * `confirmExpired` is true only for a REAL past expiry on an unconfirmed
 * account; `confirmLinkSent` is true whenever a token generation exists
 * (live or expired — issue writes hash + expiry together, consume clears
 * both). Missing rows and confirmed accounts read {false, false}. Corrupt
 * clocks (unparseable expiry) read {false, false} when no token hash is
 * present, or {false, true} when a token hash exists (link was issued
 * but expiry is corrupted — fail-closed on expiry, link-sent detected
 * from token presence). Display-only: a transient read failure degrades
 * to {false, false} (logged loudly) instead of 500ing the polling loop
 * over garnish.
 */
interface ConfirmLinkState {
  confirmExpired: boolean;
  confirmLinkSent: boolean;
}

const readConfirmState = async (steamId: string): Promise<ConfirmLinkState> => {
  const none: ConfirmLinkState = {
    confirmExpired: false,
    confirmLinkSent: false,
  };
  try {
    const account = await getAccount(steamId);
    if (account === null || account.confirmedAt !== null) return none;
    const linkSent = (account.confirmTokenHash ?? null) !== null;
    if (account.confirmExpiresAt === null) {
      return { confirmExpired: false, confirmLinkSent: linkSent };
    }
    return {
      confirmExpired: Date.parse(account.confirmExpiresAt) <= Date.now(),
      confirmLinkSent: linkSent,
    };
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('watchStatus:confirmExpired', sanitizeError(error), {
      steamId,
    });
    return none;
  }
};

/**
 * Returns the current watch state for the LOGGED-IN profile — exclusively
 * one of 'pending' | 'active' | 'none' ('none' covers never-requested AND
 * opted-out/deactivated: both mean "no watch", and the distinction is
 * internal state the API deliberately does not expose).
 *
 * Plus `confirmExpired` (link died unclicked → drives the resend UI)
 * and `confirmLinkSent` (a generation exists, live or expired → drives
 * the "check your chat" hint instead of the invite hint). Both true only
 * on real account state — missing rows and confirmed accounts read
 * {false, false}. Corrupt clocks (unparseable expiry) read {false, false}
 * when no token hash is present, or {false, true} when a token hash
 * exists (link was issued but expiry is corrupted — fail-closed on
 * expiry, link-sent detected from token presence). Display-only like the
 * confirm route's locale read: a transient failure degrades to false
 * (logged loudly) instead of 500ing the polling loop over garnish.
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
    const confirmState =
      status === 'pending'
        ? await readConfirmState(steamId)
        : { confirmExpired: false, confirmLinkSent: false };
    return NextResponse.json(
      {
        steamId,
        status: status ?? 'none',
        ...confirmState,
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
