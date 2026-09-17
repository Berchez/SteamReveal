import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import getSteamApiKey from '@/lib/getSteamApiKey';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { isSteamId64 } from '@/lib/steamId';
import { BOT_FRIENDSHIP_TIMEOUT_MS, isBotFriend } from '@/lib/steamFriendList';
import withTimeout from '@/lib/withTimeout';
import { completeProvenLogin } from '@/lib/watch/completeLogin';
import { savePendingLogin } from '@/lib/watch/pendingLogin';
import { WATCH_OAUTH_STATE_COOKIE } from '@/lib/watch/sessionCookie';
import { isSafeNextPath, verifySteamAssertion } from '@/lib/watch/steamOpenId';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';

export const runtime = 'nodejs';

export const revalidate = 0;

// Same generous per-IP cap as login: each callback hit costs one Steam
// verification POST plus one GetFriendList read, so an uncleansed flood
// would turn our server into a (Steam-fixed-target) request amplifier.
// Humans log in rarely.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const callbackRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Steam OpenID callback: Steam GETs the signed assertion here after the
 * user approves. Three independent gates, all required:
 * 1. login-CSRF `state`: the query nonce must match the single-use cookie
 *    planted by the login route (timing-safe compare). A mismatch means
 *    nobody started this login in this browser — reject before touching
 *    Steam or the session. The cookie is cleared on EVERY hit (single-use
 *    by design: replaying a captured callback URL a second time fails).
 * 2. direct verification: the assertion is replayed (check_authentication)
 *    and the SteamID64 is trusted ONLY on `is_valid:true`.
 * 3. single-state friendship gate: the main bot as a Steam friend
 *    (GetFriendList against the bot's own list — it must stay public).
 *    Friendship IS the explicit opt-in act under the single-state model:
 *    adding the bot is how you say "watch me". Already friends -> the
 *    watch activates and the session seals right here. Not friends -> the
 *    login is HELD, not denied: a short-lived pending login is sealed and
 *    the browser lands on the waiting room (`next?login=waiting`), which
 *    completes the login by itself once the friendship appears — no second
 *    OpenID dance. Unknown (Steam API down, private list, misconfigured
 *    env) -> the generic `?auth=error`, FAIL-CLOSED by decision (a login
 *    is already Steam-dependent, so this adds no new dependency class;
 *    and waiting cannot help while the gate itself is broken).
 *
  * Single-state invariant: fresh logins ALWAYS leave with an ACTIVE watch
  * row (inserted directly), while a re-login on a confirm-lane pending row
  * (unconfirmed account — link not yet clicked) preserves the pending state
  * and still seals the session (login succeeds; the click stays the sole
  * activator). The completion order is load-bearing and lives in ONE place
  * (`completeProvenLogin`, shared with the pending route) — this file owns
  * only the gates above, never the order. The residual window for a stale
  * sealed cookie after an unfriend is bounded by the co-checks in the
  * authed routes (status/notifications) and documented in the PROD_READINESS
  * backlog.
 *
 * Every failure mode lands on `next?auth=error`, where the home page's
 * one-shot toast shows the error state — never a JSON blob or a stack
 * trace in the browser flow.
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
  const next = isSafeNextPath(rawNext) ? rawNext : '/';
  // Built with the URL API (never string-concatenated `?auth=error`):
  // robust even if a future `next` legitimately carries its own query.
  const failUrl = (() => {
    const failure = new URL(`${url.origin}${next}`);
    failure.searchParams.set('auth', 'error');
    return failure.toString();
  })();
  // Waiting-room landing for the login-first flow: the OpenID identity is
  // already proven, only the friendship is outstanding.
  const waitingUrl = (() => {
    const waiting = new URL(`${url.origin}${next}`);
    waiting.searchParams.set('login', 'waiting');
    return waiting.toString();
  })();
  const clearStateCookie = (response: NextResponse): NextResponse => {
    response.cookies.set(WATCH_OAUTH_STATE_COOKIE, '', {
      path: '/',
      maxAge: 0,
    });
    return response;
  };
  const fail = () => clearStateCookie(NextResponse.redirect(failUrl, 302));

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

    // ---- Gate 3: single-state friendship check (fail-closed) ----
    const apiKey = getSteamApiKey();
    const botSteamId = process.env.STEAM_BOT_STEAMID;
    if (typeof apiKey !== 'string' || apiKey === '' || !isSteamId64(botSteamId)) {
      logRouteError(
        'steamCallback',
        'friendship gate misconfigured: STEAM_API_KEY or STEAM_BOT_STEAMID missing/invalid — login denied fail-closed (operator action required)',
      );
      return fail();
    }
    let isFriend: boolean | null;
    try {
      isFriend = await withTimeout(
        isBotFriend(apiKey, botSteamId, steamId),
        'steamCallback: GetFriendList',
        BOT_FRIENDSHIP_TIMEOUT_MS,
      );
    } catch (error) {
      logRouteError('steamCallback:friendship', sanitizeError(error), {
        steamId,
      });
      isFriend = null;
    }
    if (isFriend === false) {
      // Login-first flow: HOLD the verified identity instead of denying.
      // The waiting room completes the login by itself once the friendship
      // appears (pending route re-proves it server-side). Nothing is
      // sealed and nothing is written here — the wait simply begins.
      await savePendingLogin(cookies(), steamId, next);
      return clearStateCookie(NextResponse.redirect(waitingUrl, 302));
    }
    if (isFriend !== true) {
      logRouteError(
        'steamCallback',
        'friendship status unknown (Steam API unavailable or bot friends list private) — login denied fail-closed',
        { steamId },
      );
      return fail();
    }

    // ---- Single-state invariant: active watch BEFORE session ----
    // Shared completion (see completeLogin.ts — the same order the pending
    // route runs; one implementation, never two copies to drift).
    const { activated } = await completeProvenLogin(
      cookies(),
      steamId,
      next,
      'steamCallback',
    );
    const success = new URL(`${url.origin}${next}`);
    // First-login one-shot toast param (QueryToast fires watchWelcome
    // once and strips it): the poll-based pending->active toast is dead
    // under the single-state model (no pending ever exists), so this is
    // the only "your watch is live" signal for a fresh profile.
    if (activated) success.searchParams.set('watch', 'new');
    return clearStateCookie(NextResponse.redirect(success.toString(), 302));
  } catch (error) {
    logRouteError('steamCallback', sanitizeError(error));
    return fail();
  }
}
