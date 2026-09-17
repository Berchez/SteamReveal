import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import getSteamApiKey from '@/lib/getSteamApiKey';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { isSteamId64 } from '@/lib/steamId';
import { isBotFriend } from '@/lib/steamFriendList';
import withTimeout from '@/lib/withTimeout';
import {
  ensureActiveWatch,
  enqueueEvent,
  recordLogin,
} from '@/lib/analytics/db';
import { saveWatchSession } from '@/lib/watch/session';
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
 * Bounded friendship check: a hung GetFriendList must fail the login
 * visibly (fail-closed), not wedge it for the default fetch timeout.
 * Same accepted limitation as everywhere withTimeout is used: the
 * underlying request is not aborted, only our wait for it.
 */
const FRIENDSHIP_TIMEOUT_MS = 8000;

/**
 * Welcome-enqueue retries (mirrors the confirm route's 3-attempt
 * discipline): a single DB blip must not silently eat the only welcome
 * — nothing re-emits it later under the single-state model (reconcile
 * only activates pending rows; this row is already active).
 */
const WELCOME_ATTEMPTS = 3;

/**
 * Locale for the watch row / login registry / bot messages: the page the
 * user is ON carries it (`next` is locale-prefixed by resolveLoginNext
 * — '/pt/player/x' -> 'pt'). Unknown shapes resolve to null (bot
 * messages fall back to English), never block the login.
 */
const localeFromNext = (next: string): string | null =>
  next.match(/^\/([a-z]{2})(?:\/|$)/i)?.[1]?.toLowerCase() ?? null;

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
 * 3. single-state friendship gate (NEW): the user must ALREADY have the
 *    main bot as a Steam friend (GetFriendList against the bot's own
 *    list — it must stay public). Friendship IS the explicit opt-in act
 *    under the single-state model: adding the bot is how you say "watch
 *    me". Not friends -> `next?auth=nofriend` (distinct toast + the
 *    sign-in panel explains the flow); unknown (Steam API down, private
 *    list, misconfigured env) -> the generic `?auth=error`, FAIL-CLOSED
 *    by decision (a login is already Steam-dependent, so this adds no
 *    new dependency class).
 *
  * Single-state invariant enforced HERE (the only production login path):
  * fresh logins ALWAYS leave with an ACTIVE watch row (inserted directly),
  * while a re-login on a confirm-lane pending row (unconfirmed account —
  * link not yet clicked) preserves the pending state and still seals the
  * session (login succeeds; the click stays the sole activator). Order is
  * load-bearing: ensureActiveWatch (fatal) -> recordLogin (audit,
  * non-fatal) -> welcome once (non-fatal, retried) -> saveWatchSession.
  * The residual window for a stale sealed cookie after an unfriend is
  * bounded by the co-checks in the authed routes (status/notifications)
  * and documented in the PROD_READINESS backlog.
 *
 * Every failure mode lands on `next?auth=error` (or `?auth=nofriend`
 * for the friendship denial), where the home page's one-shot toast shows
 * the error state — never a JSON blob or a stack trace in the browser
 * flow.
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
  // Distinct denial for the friendship gate: the pre-login panel and this
  // toast are the two surfaces that teach the add-the-bot-first flow.
  const nofriendUrl = (() => {
    const denial = new URL(`${url.origin}${next}`);
    denial.searchParams.set('auth', 'nofriend');
    return denial.toString();
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
        FRIENDSHIP_TIMEOUT_MS,
      );
    } catch (error) {
      logRouteError('steamCallback:friendship', sanitizeError(error), {
        steamId,
      });
      isFriend = null;
    }
    if (isFriend === false) {
      return clearStateCookie(NextResponse.redirect(nofriendUrl, 302));
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
    const locale = localeFromNext(next);
    const { activated } = await ensureActiveWatch(steamId, locale);
    // Login registry (ops audit): non-fatal by contract — a failed audit
    // write costs a log line, never the login (the watch row above is the
    // load-bearing state; this row only answers "who logs in, when").
    try {
      await recordLogin(steamId, locale);
    } catch (error) {
      logRouteError('steamCallback:recordLogin', sanitizeError(error), {
        steamId,
      });
    }
    // Welcome once: ONLY the call that actually flipped the row (fresh
    // insert or confirmed/grandfathered pending flip) enqueues it —
    // idempotent re-logins and confirm-lane preservations stay silent.
    // Retried; still non-fatal (login > welcome).
    if (activated) {
      let welcomed = false;
      for (let attempt = 0; attempt < WELCOME_ATTEMPTS && !welcomed; attempt += 1) {
        try {
          // eslint-disable-next-line no-await-in-loop
          await enqueueEvent(steamId, 'welcome');
          welcomed = true;
        } catch (error) {
          logRouteError('steamCallback:welcome', sanitizeError(error), {
            steamId,
            attempt: attempt + 1,
          });
        }
      }
    }

    await saveWatchSession(cookies(), steamId);
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
