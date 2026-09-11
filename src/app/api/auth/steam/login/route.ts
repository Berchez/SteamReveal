import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

import { errorResponse } from '@/lib/apiError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { buildSteamLoginUrl, isSafeNextPath } from '@/lib/watch/steamOpenId';
import { WATCH_OAUTH_STATE_COOKIE } from '@/lib/watch/sessionCookie';

export const runtime = 'nodejs';

export const revalidate = 0;

// Generous per-IP cap (repo convention: every route has one): legitimate
// use is ~1 hit per login, so 30/min never binds a human — it only sheds
// redirect-generation floods.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const loginRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/** Login-CSRF nonce lifetime: long enough for a Steam login, nothing more. */
const STATE_COOKIE_MAX_AGE_SECONDS = 600;

/**
 * Starts Steam OpenID login: 302s the browser to Steam's checkid_setup
 * with identifier_select. `?next=/<locale>/watch` (optional) is carried
 * inside return_to so the callback can send the user back to the watch
 * flow without losing context — validated as an internal path (open
 * redirectors need not apply), defaulting to `/watch` (the locale
 * middleware prefixes it).
 *
 * Also plants a single-use `state` nonce (httpOnly cookie + echoed query
 * param) so the callback can reject logins nobody started in this browser
 * (login CSRF). Stateless 302 otherwise: no DB, no session.
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (loginRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const url = new URL(req.url);
  const rawNext = url.searchParams.get('next');
  const next = isSafeNextPath(rawNext) ? rawNext : '/watch';
  const state = randomBytes(16).toString('hex');
  const loginUrl = buildSteamLoginUrl({
    returnTo: `${url.origin}/api/auth/steam/callback?next=${encodeURIComponent(next)}&state=${state}`,
    realm: url.origin,
  });
  const response = NextResponse.redirect(loginUrl, 302);
  response.cookies.set(WATCH_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: STATE_COOKIE_MAX_AGE_SECONDS,
  });
  return response;
}
