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
import { resolveBotProfileUrl } from '@/lib/watch/botProfile';
import { completeProvenLogin } from '@/lib/watch/completeLogin';
import { clearPendingLogin, getPendingLogin } from '@/lib/watch/pendingLogin';
import {
  PENDING_RATE_LIMIT_MAX,
  PENDING_RATE_LIMIT_WINDOW_MS,
} from '@/lib/watch/pendingPolicy';
import { isSafeNextPath } from '@/lib/watch/steamOpenId';

export const runtime = 'nodejs';

export const revalidate = 0;

// Generous per-IP cap shared with the client cadence (see pendingPolicy:
// fast tier ≈6/min, ×2 tabs worst case — far under this budget, so it only
// ever sheds floods, never humans). Each poll costs one Steam GetFriendList
// read; without a cap an uncleansed flood turns our server into a
// (Steam-fixed-target) request amplifier.
const pendingRateLimiter = createRateLimiter(
  PENDING_RATE_LIMIT_WINDOW_MS,
  PENDING_RATE_LIMIT_MAX,
);

type PendingResult =
  | { done: false; expired?: false; botProfileUrl: string | null }
  | { done: false; expired: true; botProfileUrl: string | null }
  | { done: true; redirect: string; botProfileUrl: string | null };

/**
 * JSON responses never cache (poll semantics + a session-sealing GET):
 * neither the browser nor any intermediary may store or replay them.
 */
const jsonNoStore = (body: PendingResult): NextResponse =>
  NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });

/**
 * Waiting-room poll for the login-first flow (`?login=waiting`): completes
 * a pending login the moment the bot friendship appears — no second
 * OpenID dance.
 *
 * State machine, all server-side (the client only renders):
 * - no/invalid/expired pending cookie → `{done:false, expired:true}` (the
 *   room shows "start over"). Answered identically with no oracle: an
 *   absent cookie and a forged one look the same.
 * - misconfigured gate (key/bot id) → logged LOUDLY (operator action) and
 *   answered as expired: retrying cannot help until the env is fixed, and
 *   failing closed here can never seal.
 * - friendship not (yet) proven — `false` AND `null` (Steam blip, private
 *   list, bot hasn't accepted yet) → `{done:false}`: the room keeps
 *   waiting until the pending TTL. Transient unknowns recover on the next
 *   tick instead of killing the wait.
  * - friendship proven → the SHARED completion (`completeProvenLogin` —
  *   the same implementation the callback runs: ensure fatal →
  *   recordLogin non-fatal → welcome once if activated → seal session)
  *   plus pending-clearing, and `{done:true, redirect}`. A throw in the
  *   shared completion keeps waiting (transient blips recover on the next
  *   tick, TTL-bounded) instead of expiring the room — but logs loudly
  *   every time, so a sustained outage is visible, not silent.
 *
 * GET seals a session by design here (poll semantics): safe because (a)
 * nothing links to this URL — only the room fetches it, so prefetchers
 * never touch it; (b) the Lax pending cookie doesn't travel on cross-site
 * subrequests; (c) triggering it cross-site would only complete the
 * victim's OWN login (no privilege transferred); (d) friendship is
 * re-proven server-side on every hit — the client claim is never trusted.
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (pendingRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const botProfileUrl = resolveBotProfileUrl();

  const pending = await getPendingLogin(cookies());
  if (pending === null) {
    return jsonNoStore({ done: false, expired: true, botProfileUrl });
  }
  const { steamId } = pending;
  // Belt over the callback's validation (stored value, re-checked): a
  // hand-minted pending can never become a redirector or a bad DAL call.
  const next = isSafeNextPath(pending.next) ? pending.next : '/';
  if (!isSteamId64(steamId)) {
    logRouteError('steamPending', 'pending identity failed validation');
    return jsonNoStore({ done: false, expired: true, botProfileUrl });
  }

  try {
    const apiKey = getSteamApiKey();
    const botSteamId = process.env.STEAM_BOT_STEAMID;
    if (typeof apiKey !== 'string' || apiKey === '' || !isSteamId64(botSteamId)) {
      logRouteError(
        'steamPending',
        'friendship gate misconfigured: STEAM_API_KEY or STEAM_BOT_STEAMID missing/invalid — completion refused fail-closed (operator action required)',
      );
      return jsonNoStore({ done: false, expired: true, botProfileUrl });
    }
    let isFriend: boolean | null;
    try {
      isFriend = await withTimeout(
        isBotFriend(apiKey, botSteamId, steamId),
        'steamPending: GetFriendList',
        BOT_FRIENDSHIP_TIMEOUT_MS,
      );
    } catch (error) {
      logRouteError('steamPending:friendship', sanitizeError(error), {
        steamId,
      });
      isFriend = null;
    }
    if (isFriend !== true) {
      // Still waiting (or Steam blipped): the room retries on its next
      // tick. Never seals, never expires the room early. But an UNKNOWN
      // read (null — private list, dead key, Steam outage) is logged LOUDLY
      // every time, unlike a plain not-yet-friend (false, the expected
      // steady state, kept silent): without this, a misconfigured bot list
      // would hold every waiting room for 30 minutes with zero log signal
      // distinguishing "hasn't added yet" from "gate is broken".
      if (isFriend === null) {
        logRouteError(
          'steamPending:friendship-unknown',
          'friendship status unknown (Steam API unavailable or bot friends list private) — wait continues, completion refused until proven',
          { steamId },
        );
      }
      return jsonNoStore({ done: false, botProfileUrl });
    }

    // ---- Friendship proven: shared completion (see completeLogin.ts) ----
    let activated = false;
    try {
      ({ activated } = await completeProvenLogin(
        cookies(),
        steamId,
        next,
        'steamPending',
      ));
    } catch (error) {
      // Transient DB blip (or a seal failure): keep waiting (next tick
      // retries idempotently, TTL bounds the wait) instead of expiring a
      // healthy pending — but loudly, every time, so a sustained outage
      // pages through the logs, not silence.
      logRouteError('steamPending:ensure', sanitizeError(error), { steamId });
      return jsonNoStore({ done: false, botProfileUrl });
    }
    // Clearing is best-effort AFTER the seal (login > bookkeeping): a
    // failure here only means the next poll re-completes idempotently
    // (no welcome re-fire — the row is already active).
    try {
      await clearPendingLogin(cookies());
    } catch (error) {
      logRouteError('steamPending:clear', sanitizeError(error), { steamId });
    }
    const url = new URL(req.url);
    const redirect = new URL(`${url.origin}${next}`);
    if (activated) redirect.searchParams.set('watch', 'new');
    return jsonNoStore({
      done: true,
      redirect: redirect.toString(),
      botProfileUrl,
    });
  } catch (error) {
    logRouteError('steamPending', sanitizeError(error));
    return jsonNoStore({ done: false, expired: true, botProfileUrl });
  }
}
