import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import { saveWatchSession } from '@/lib/watch/session';
import { WATCH_OAUTH_STATE_COOKIE } from '@/lib/watch/sessionCookie';
import { isSafeNextPath, verifySteamAssertion } from '@/lib/watch/steamOpenId';

export const runtime = 'nodejs';

export const revalidate = 0;

// Same generous per-IP cap as login: each callback hit costs one Steam
// verification POST, so an uncleansed flood would turn our server into a
// (Steam-fixed-target) request amplifier. Humans log in rarely.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const callbackRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Steam OpenID callback: Steam GETs the signed assertion here after the
 * user approves. Two independent gates, both required:
 * 1. login-CSRF `state`: the query nonce must match the single-use cookie
 *    planted by the login route (timing-safe compare). A mismatch means
 *    nobody started this login in this browser — reject before touching
 *    Steam or the session. The cookie is cleared on EVERY hit (single-use
 *    by design: replaying a captured callback URL a second time fails).
 * 2. direct verification: the assertion is replayed (check_authentication)
 *    and the SteamID64 is trusted ONLY on `is_valid:true`.
 *
 * Every failure mode lands on `next?auth=error`, where the watch page
 * shows the login error state — never a JSON blob or a stack trace in the
 * browser flow.
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (callbackRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const url = new URL(req.url);
  const params: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    params[key] = value;
  });
  const rawNext = params.next;
  const next = isSafeNextPath(rawNext) ? rawNext : '/watch';
  // Built with the URL API (never string-concatenated `?auth=error`):
  // robust even if a future `next` legitimately carries its own query.
  const failUrl = (() => {
    const failure = new URL(`${url.origin}${next}`);
    failure.searchParams.set('auth', 'error');
    return failure.toString();
  })();
  const fail = () => {
    const response = NextResponse.redirect(failUrl, 302);
    response.cookies.set(WATCH_OAUTH_STATE_COOKIE, '', {
      path: '/',
      maxAge: 0,
    });
    return response;
  };

  const stateCookie = cookies().get(WATCH_OAUTH_STATE_COOKIE)?.value ?? null;
  const stateParam = typeof params.state === 'string' ? params.state : null;
  if (
    stateCookie === null ||
    stateParam === null ||
    !timingSafeEqualStrings(stateCookie, stateParam)
  ) {
    logRouteError(
      'steamCallback',
      'OpenID state mismatch (login not started here)',
    );
    return fail();
  }

  try {
    const steamId = await verifySteamAssertion(params);
    if (steamId === null) {
      logRouteError('steamCallback', 'OpenID assertion rejected by Steam');
      return fail();
    }
    await saveWatchSession(cookies(), steamId);
    const response = NextResponse.redirect(`${url.origin}${next}`, 302);
    response.cookies.set(WATCH_OAUTH_STATE_COOKIE, '', {
      path: '/',
      maxAge: 0,
    });
    return response;
  } catch (error) {
    logRouteError('steamCallback', sanitizeError(error));
    return fail();
  }
}
