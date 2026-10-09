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
import { createAccount } from '@/lib/analytics/db';
import { hasAccountFootprint } from '@/lib/watch/searcherAttribution';
import { shouldThrottleReconnectRead } from '@/lib/watch/reconnectThrottle';
import { resolveBotProfileUrl } from '@/lib/watch/botProfile';
import { resolveWatchSession } from '@/lib/watch/session';
import {
  PENDING_RATE_LIMIT_MAX,
  PENDING_RATE_LIMIT_WINDOW_MS,
} from '@/lib/watch/pendingPolicy';

export const runtime = 'nodejs';
export const revalidate = 0;

// Reuses the pending-room budget on purpose: the client polls on the SAME
// cadence (pendingPollDelay, imported from pendingPolicy by the modal),
// so the arithmetic that keeps polls/min under the per-IP cap must stay
// in the single shared file — a second copy here is exactly the drift
// pendingPolicy's docblock forbids. Each poll costs one GetFriendList
// read against the shared Steam quota; the cap sheds floods, never a
// human waiting at 6/min.
const reconnectRateLimiter = createRateLimiter(
  PENDING_RATE_LIMIT_WINDOW_MS,
  PENDING_RATE_LIMIT_MAX,
);

type ReconnectResult = {
  done: boolean;
  botProfileUrl: string | null;
};

/**
 * JSON responses never cache (poll semantics + a state-changing GET):
 * neither the browser nor any intermediary may store or replay them.
 */
const jsonNoStore = (body: ReconnectResult): NextResponse =>
  NextResponse.json(body, {
    status: 200,
    headers: { 'Cache-Control': 'no-store' },
  });

/**
 * Reconnect poll for the history modal's paused state ("you left Watch"):
 * the viewer clicks the CTA, adds the bot in another tab, and this lane
 * completes the resume the moment the bot accepts — mirroring the login
 * waiting room, minus the OpenID dance (the sealed session already
 * proves account ownership).
 *
 * Scope — HISTORY ONLY, by design: completion recreates the ACCOUNTS row
 * (the attribution anchor whose absence made the modal pause), never a
 * watch. Re-activating notifications stays on the explicit Start lane
 * (signup → invite → confirm link → click), so the click-to-activate
 * consent gate for watches is untouched — friendship alone resumes
 * exactly what friendship alone paused: attribution. A LATER full login
 * re-enters the existing login flow unchanged (for a friend,
 * ensureActiveWatch activates as it always has — nothing this lane adds
 * or removes there); a reconnect user who never logs in simply stays
 * friend + account + no watch, and WatchManager shows Start.
 *
 * State machine, all server-side (the client only renders):
 * - footprint already exists → `{done:true}` WITHOUT a Steam read:
 *   idempotent, and free for the common re-opened-modal case (the bot
 *   accepted while the modal was closed, or the user re-logged-in
 *   elsewhere — completeProvenLogin rebuilds the row through
 *   ensureActiveWatch's account handling).
 * - friendship not (yet) proven (false) or unknown (null — Steam blip,
 *   private list) → `{done:false}`: keep waiting. Null logs LOUDLY every
 *   time (same rationale as the pending route: a broken gate must be
 *   distinguishable from "hasn't added yet" in the logs).
 * - friendship proven → createAccount (idempotent) → `{done:true}`. A
 *   transient DB failure answers `{done:false}` (the poll retries next
 *   tick) instead of 500ing the wait — logged loudly every time.
 * - misconfigured gate (key/bot id) → logged LOUDLY and `{done:false}`:
 *   retrying cannot help until the env is fixed; the wait just looks
 *   slow, which is the honest rendering of an ops problem.
 *
 * GET mutates by design here (poll semantics, same precedent and safety
 * argument as /api/auth/steam/pending): nothing links to this URL — only
 * the modal fetches it, so prefetchers never touch it; the Lax session
 * cookie is withheld on cross-site SUBREQUESTS (fetch/XHR), though it IS
 * sent on a cross-site top-level GET navigation (user clicking a link).
 * Triggering it that way could only recreate the victim's OWN history
 * anchor (no privilege transferred, no other user's state reachable);
 * and friendship is re-proven server-side on every hit — the client
 * claim is never trusted.
 *
 * Self-scoped like the sibling history lanes: identity comes
 * EXCLUSIVELY from the sealed session cookie (`?steamId=` is a 400, a
 * missing session is a 401). `locale` is informational only (bot message
 * language + row bookkeeping; normalizeLocale inside the DAL coerces
 * junk to null — it can never be load-bearing).
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (reconnectRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const params = new URL(req.url).searchParams;
  if (params.has('steamId')) {
    // Identity comes EXCLUSIVELY from the sealed session cookie: a
    // client-supplied steamId is forgeable, so it is a 400, not a hint.
    return errorResponse(
      'Invalid request: steamId comes from the login session, not the query string.',
      400,
      'INVALID_REQUEST',
    );
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('historyReconnect', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while resuming search history.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;
  // Fetch-metadata CSRF layer (the modal is the only caller, via
  // same-origin fetch): browsers stamp every fetch with Sec-Fetch-Site,
  // so a PRESENT non-same-origin value (cross-site fetch, top-level
  // navigation from another site) is a forged drive-by — reject it.
  // Fail OPEN on missing (curl, old browsers, unit tests construct bare
  // Requests): the state change only ever recreates the caller's OWN
  // history anchor, and friendship is still re-proven below — the
  // header upgrades the common case instead of carrying the guarantee.
  const fetchSite = req.headers.get('sec-fetch-site');
  if (fetchSite !== null && fetchSite !== 'same-origin') {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }
  const botProfileUrl = resolveBotProfileUrl();

  // Footprint fast path: already reconnected (bot accepted while nobody
  // polled, or a login elsewhere rebuilt the row). One indexed PK read,
  // zero Steam quota — and the answer stays idempotent for however many
  // tabs poll it.
  try {
    if (await hasAccountFootprint(steamId)) {
      return jsonNoStore({ done: true, botProfileUrl });
    }
  } catch (error) {
    // Transient DB blip on the cheap read: keep waiting (next tick
    // retries) instead of 500ing the wait — but loudly, every time.
    logRouteError('historyReconnect:footprint', sanitizeError(error), {
      steamId,
    });
    return jsonNoStore({ done: false, botProfileUrl });
  }

  const apiKey = getSteamApiKey();
  const botSteamId = process.env.STEAM_BOT_STEAMID;
  if (typeof apiKey !== 'string' || apiKey === '' || !isSteamId64(botSteamId)) {
    logRouteError(
      'historyReconnect',
      'friendship gate misconfigured: STEAM_API_KEY or STEAM_BOT_STEAMID missing/invalid — resume refused fail-closed (operator action required)',
    );
    return jsonNoStore({ done: false, botProfileUrl });
  }

  try {
    let isFriend: boolean | null;
    // A withTimeout throw already logs its detail below; the generic
    // friendship-unknown line stays reserved for isBotFriend RESOLVING
    // null (private list) — one blip, one log line, not two.
    let friendshipThrew = false;
    try {
      // Per-viewer throttle (reconnectThrottle): the modal polls per
      // open tab, so one waiter with N tabs costs N GetFriendList reads
      // per tick against the shared Steam quota. A throttled tick
      // answers `{done:false}` without reading — the poll retries next
      // tick (worst case adds one interval of resume latency). The
      // footprint fast path above is deliberately NOT throttled:
      // completion must stay instant once the row exists.
      if (shouldThrottleReconnectRead(steamId)) {
        return jsonNoStore({ done: false, botProfileUrl });
      }
      isFriend = await withTimeout(
        isBotFriend(apiKey, botSteamId, steamId),
        'historyReconnect: GetFriendList',
        BOT_FRIENDSHIP_TIMEOUT_MS,
      );
    } catch (error) {
      friendshipThrew = true;
      logRouteError('historyReconnect:friendship', sanitizeError(error), {
        steamId,
      });
      isFriend = null;
    }
    if (isFriend !== true) {
      // Still waiting (or Steam blipped): the modal retries on its next
      // tick. Never mutates, never 500s the wait. An UNKNOWN read (null)
      // is logged LOUDLY every time, unlike a plain not-yet-friend
      // (false, the expected steady state, kept silent) — same log
      // discipline as the pending route.
      if (isFriend === null && !friendshipThrew) {
        logRouteError(
          'historyReconnect:friendship-unknown',
          'friendship status unknown (Steam API unavailable or bot friends list private) — resume refused until proven',
          { steamId },
        );
      }
      return jsonNoStore({ done: false, botProfileUrl });
    }

    // ---- Friendship proven: recreate the attribution anchor ----
    // Idempotent (existing row returned untouched), so concurrent tabs
    // and a racing login converge on one row. The unconfirmed fresh row
    // only affects the confirm-link lane (watches) — attribution checks
    // existence alone.
    const localeParam = params.get('locale');
    await createAccount(steamId, localeParam);
    return jsonNoStore({ done: true, botProfileUrl });
  } catch (error) {
    // Transient DB failure on the write: keep waiting (next tick retries
    // idempotently) instead of 500ing the wait — but loudly, every time,
    // so a sustained outage pages through the logs, not silence.
    logRouteError('historyReconnect:createAccount', sanitizeError(error), {
      steamId,
    });
    return jsonNoStore({ done: false, botProfileUrl });
  }
}
