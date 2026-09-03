import { NextResponse } from 'next/server';
import axios from 'axios';
import SteamAPI, { UserSummary } from 'steamapi';
import getSteamApiKey from '@/lib/getSteamApiKey';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import isValidTargetParam from '@/lib/isValidTargetParam';
import { errorResponse } from '@/lib/apiError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
import isSteamUnauthorizedError from '@/lib/isSteamUnauthorizedError';

import { isValidCloseFriendItem } from './utils/validateCloseFriends';
import getBadCommentsScore from './utils/badCommentsMethod';
import getBannedFriendsScore from './utils/bannedFriendsMethod';
import getInventoryScore from './utils/inventoryMethod';
import getGameLibraryStats from './utils/gameLibraryStatsMethod';
import getPlatformBanScore from './utils/platformBanMethod';
import getCsStats, {
  CS_STATS_FIELD_ORDER,
  assertCsStatsShape,
} from './utils/csStats';
import { clearStat, getAccountAge } from './utils/utils';

export const revalidate = 0;

const steamApiKey = getSteamApiKey();
if (!steamApiKey) {
  console.error(
    'getCheaterProbability - STEAM_API_KEY is missing at module init. Every request to this route will fail until it is set.',
  );
}
const steam = new SteamAPI(steamApiKey ?? '');

const { CHEATER_AI_API_BASE } = process.env;

const FIVE_MINS_IN_MS = 5 * 60 * 1000;
const STEAM_CALL_TIMEOUT_MS = 8000;

// This is the most expensive route in the project (multiple Steam calls +
// scraping + a call to the ML inference service), so it gets a tighter
// window/lower ceiling than the plain lookup routes.
const RATE_LIMIT_WINDOW_MS = 30_000;
const RATE_LIMIT_MAX = 5;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function POST(req: Request) {
  // Standardized order across all routes: method check -> rate limit ->
  // parse body -> validate -> business logic.
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  const ip = getRequestIp(req);
  if (rateLimiter.isRateLimited(ip)) {
    return errorResponse(
      'Too many requests. Try again later.',
      429,
      'RATE_LIMITED',
    );
  }

  let body;
  try {
    body = await req.json();

    const { closeFriends, target } = body;

    // Reject oversized/malformed payloads before touching Steam API at
    // all.
    //
    // Note: getBannedFriendsScore makes ONE batched call to
    // steam.getUserBans(steamIDs) with the whole array — not one Steam
    // API call per item as originally assumed. The size cap below still
    // matters (it bounds that single call's payload and every per-item
    // computation that follows), but it does NOT by itself neutralize
    // the sharper abuse vector: a single well-formed item with an
    // unbounded `count` can blow up calcBansWeight's
    // `3 ** (bansSum * count)` to Infinity. That is capped separately in
    // isValidCloseFriendItem (see MAX_FRIEND_COUNT there) — the length
    // check here and the per-item shape/bounds check below are both
    // required, neither is sufficient alone.
    if (
      !Array.isArray(closeFriends) ||
      !isValidTargetParam(target) ||
      closeFriends.length > MAX_CLOSE_FRIENDS
    ) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    // Reject malformed items (bad steamID, bad/unbounded count) before
    // they reach getBannedFriendsScore / calcBansWeight downstream.
    if (!closeFriends.every(isValidCloseFriendItem)) {
      return errorResponse('Invalid request body.', 400, 'INVALID_REQUEST');
    }

    const targetSteamId = await withTimeout(
      steam.resolve(target),
      'getCheaterProbability: steam.resolve',
      STEAM_CALL_TIMEOUT_MS,
    );

    // ─────────────────────────────────────────────────────────────────────────────
// RATE-LIMIT / "Too Many Requests" (429) WATCHLIST — which helpers hit which
// external source, how fragile each one is, and what to monitor.
//
// One request to this route fires MANY external calls in parallel (the
// Promise.all below). The helpers below are the ones most prone to returning
// 'Too Many Requests' / 'Rate Limit' — in rough order of severity:
//
//  1. csStats (getCsStats)                       → LEETIFY (public no-auth)
//       · 2 concurrent calls: api-public.cs-prod.leetify.com/v3/profile
//         + api.cs-prod.leetify.com/api/profile/id/:id.
//       · Rate-limits HARD when LEETIFY_API_KEY is absent (sharedHeaders
//         becomes undefined → unauthenticated traffic shares a global bucket).
//       · Failures are swallowed silently (returns null) — easy to miss.
//       · MONITOR: Leetify network errors; consider setting LEETIFY_API_KEY.
//
//  2. inventoryMethod (getInventoryScore)        → STEAMCOMMUNITY scrape
//       · GET steamcommunity.com/inventory/:id/730/2 — 1+ requests when the
//         inventory is paginated (more_items), with 1.5s sleep between pages.
//       · Already handles 429 with exponential-backoff retry (see
//         steamInventory.ts), but 5 retries × 2s cap is easy to starve under
//         load. Needs a real IP / no aggressive shared-IP traffic.
//       · MONITOR: '429 detected. Retrying' warns and 'Too many requests (429).
//         Retry limit reached.' exceptions (score silently becomes -1).
//
//  3. platformBanMethod/faceitBans (getFaceitBanStatus)
//                                                    → FACEIT Open Data API
//       · 4 calls per player, two stages: first resolve the player (one call),
//         then the remaining three — /bans + stats/cs2 + stats/csgo — fire in
//         parallel. The two stats calls sum `segments[].stats.Matches` counters
//         to discount cheater probability for active players (the profile total).
//       · FACEIT is strict with free keys; each lookup needs the bearer token.
//       · Failures are swallowed (resolves to banned:false / matches:null); a
//         `/bans` failure no longer discards the match-count that resolved fine.
//       · MONITOR: player/bans/stats 403/429. Needs a valid FACEIT_API_KEY at high
//         search volume.
//
//  4. badCommentsMethod (getBadCommentsScore)    → STEAMCOMMUNITY scrape
//       · GET steamcommunity.com/comment/Profile/render/:id?count=200 (Cheerio).
//       · Unauthenticated, IP-fate-limited like any steamcommunity scrape; the
//         response HTML may silently degrade when throttled.
//       · Failure → catch inside helper returns -1 (silent).
//       · MONITOR: render/:id non-2xx and empty comment bodies.
//
//  5. platformBanMethod/gamersClubBan (getGamersClubBanStatus)
//                                                     → GC LOCAL PROXY
//       · GET LOCAL_PROXY_URL/api/gamersclub/:steamId?includeBan=true — the
//         proxy scrapes gamersclub.gg with GAMERSCLUB_SESSION_COOKIE and returns
//         name, ban status AND the scraped match/session count (activity that
//         discounts the cheater probability). The count is the SUM of the
//         `.gc-card-history-text` counters on the profile (one card per
//         lobby/mode/season); a page/markup change that stops them being parsed
//         simply yields matches:null (the discount silently turns off) — watch for it.
//       · The proxy is the single throttle point; a stale/rotated session
//         cookie or cloudflared tunnel churn converts to 403/timeouts.
//       · MONITOR: proxy reachability + session-cookie freshness (indirect, not
//         usually a literal 429, but kills the signal silently).
//
//  MÉDIO (official Steam Web API, tolerates more, still not a blank check):
//   · bannedFriendsMethod → steam.getUserBans(steamIDs) — ONE batched call per
//     request but with up to MAX_CLOSE_FRIENDS (100) steamIDs in the payload.
//   · gameLibraryStatsMethod → steam.getUserOwnedGames (full library fetch).
//   · route: steam.resolve / steam.getUserLevel / steam.getUserSummary.
//
//  ROUTE-LEVEL backstop: this route has its own in-route rate limiter
//  (RATE_LIMIT_WINDOW_MS=30s, RATE_LIMIT_MAX=5 per IP) which returns 429 before
//  any external call — it protects OUR backend from abuse, NOT the downstream
//  providers. When Vercel/Steam/FACEIT/Leetify start throttling, this route
//  degrades gracefully (features become -1 / null) rather than erroring loudly,
//  so the FIRST sign of trouble is usually a score that starts looking
//  suspiciously uniform, not an error page.
//
// General monitoring tips:
//   · Grep Vercel logs for the console.error strings above (e.g. '429 detected.
//     Retrying', 'getBadCommentsScore - Internal server Error',
//     'Error getting game library stats', 'Error fetching bans for close
//     friends', 'getFaceitBanStatus - error', 'getGamersClubBanStatus - error').
//   · If a single search comes back 0/empty on several features WHILE 429s
//     are present in the logs, assume provider throttling (not a code bug).
//   · Keep LEETIFY_API_KEY + FACEIT_API_KEY set, keep GAMERSCLUB_SESSION_COOKIE
//     fresh, and consider tightening/reducing the parallel fan-out if the site
//     goes global.
// ─────────────────────────────────────────────────────────────────────────────

    const [
      badCommentsScore,
      bannedFriendsResult,
      inventoryScore,
      gameLibraryStats,
      userLevel,
      csStats,
      userSummary,
      platformBanResult,
    ] = await Promise.all([
      getBadCommentsScore(targetSteamId),
      getBannedFriendsScore(closeFriends),
      getInventoryScore(targetSteamId),
      getGameLibraryStats(targetSteamId),
      withTimeout(
        steam.getUserLevel(targetSteamId),
        'getCheaterProbability: steam.getUserLevel',
        STEAM_CALL_TIMEOUT_MS,
      ),
      getCsStats(targetSteamId),
      withTimeout(
        steam.getUserSummary(targetSteamId),
        'getCheaterProbability: steam.getUserSummary',
        STEAM_CALL_TIMEOUT_MS,
      ),
      getPlatformBanScore(targetSteamId),
    ]);

    const { playTime: playTimeScore, totalGamesCount } = gameLibraryStats;

    const { score: bannedFriendsScore, bannedFriendsDetails } =
      bannedFriendsResult;

    const accountAge = getAccountAge(userSummary as UserSummary);

    // Built by explicit field name (CS_STATS_FIELD_ORDER), not
    // Object.values(csStats) — see utils/csStats/index.ts for why. If
    // getCsStats() ever returns an unexpected shape, assertCsStatsShape
    // throws here (→ 500, logged below) instead of silently sending the
    // model a misaligned feature vector.
    if (csStats) {
      assertCsStatsShape(csStats);
    }

    const csStatsFeaturesArr = csStats
      ? CS_STATS_FIELD_ORDER.map((key) => clearStat(csStats[key]))
      : Array(CS_STATS_FIELD_ORDER.length).fill(-1);

    const features = [
      badCommentsScore,
      bannedFriendsScore,
      inventoryScore,
      playTimeScore,
      userLevel,
      ...csStatsFeaturesArr,
    ].map((value) => (value === null || value === undefined ? -1 : value));

    const featureObject = {
      badCommentsScore: features[0],
      bannedFriendsScore: features[1],
      inventoryScore: features[2],
      playTimeScore: features[3],
      userLevel: features[4],
      csStats,
      analyzedFriendsCount: closeFriends.length,
      bannedFriendsDetails,
      accountAge,
      totalGamesCount,
      platformBanScore: platformBanResult.score,
      platformBanCheatCount: platformBanResult.cheatCount,
      platformBanSmurfCount: platformBanResult.smurfCount,
      platformBanOtherCount: platformBanResult.otherCount,
      platformBanDetails: platformBanResult.details,
      platformActivityDiscount: platformBanResult.activityDiscount ?? 0,
      faceitActive: platformBanResult.faceitActive ?? false,
      gcActive: platformBanResult.gcActive ?? false,
    };

    const flaskResponse = await axios.post(
      `${CHEATER_AI_API_BASE}/predict`,
      { features },
      {
        headers: {
          'Content-Type': 'application/json',
        },
        timeout: FIVE_MINS_IN_MS,
      },
    );

    const { probability } = flaskResponse.data;

    // External-platform bans are strong, deterministic signals that the ML
    // model wasn't trained on, so we adjust the model's probability directly
    // instead of feeding them into the trained feature vector (which would
    // change its input shape). The direction depends on the ban reason:
    //   - cheat  (e.g. GamersClub Anti-Cheat): +0.15 per platform, cap 0.95.
    //   - smurf  (secondary account / smurf): -0.10 per platform, floor 0.
    //   - other  (unknown/non-cheat/non-smurf): neutral.
    //
    // A separate post-model signal REDUCES the probability for players who are
    // demonstrably active on a platform whose anti-cheat is more invasive than
    // Valve's VAC (FACEIT/GamersClub): a player who grinds matches there is far
    // less likely to be running cheats. This `activityDiscount` is the sum of
    // each platform's capped discount, and it is cancelled for any platform
    // where the player is already banned for cheating ("ban wins").
    const CHEAT_PLATFORM_BOOST = 0.15;
    const SMURF_PROBABILITY_PENALTY = 0.1;
    const MAX_CHEATER_PROBABILITY = 0.95;
    const MIN_CHEATER_PROBABILITY = 0;

    const activityDiscount = platformBanResult.activityDiscount ?? 0;

    const probabilityAdjustment =
      platformBanResult.cheatCount * CHEAT_PLATFORM_BOOST -
      platformBanResult.smurfCount * SMURF_PROBABILITY_PENALTY -
      activityDiscount;

    // Round to 2 decimals: the boost/penalty terms are multiples of 0.1/0.15
    // but summing them in floats can accumulate representation error once more
    // platforms/signals are added (e.g. 0.3 + 0.5). Clamping an unrounded sum
    // could otherwise make the exact-equality assertions in the tests (and any
    // downstream consumer) flaky for values like 0.80000000000000004.
    const roundedAdjustment = Math.round(probabilityAdjustment * 100) / 100;

    const boostedProbability = Math.min(
      MAX_CHEATER_PROBABILITY,
      Math.max(
        MIN_CHEATER_PROBABILITY,
        Number(probability) + roundedAdjustment,
      ),
    );

    return NextResponse.json(
      {
        cheaterProbability: boostedProbability,
        featureObject,
      },
      { status: 200 },
    );
  } catch (error) {
    if (isSteamUnauthorizedError(error)) {
      console.warn(
        `getCheaterProbability - target's data is private: ${req.url}`,
        error,
      );
      return errorResponse(
        "Target's friends list is private or inaccessible.",
        400,
        'INVALID_REQUEST',
      );
    }

    if (error instanceof SyntaxError) {
      logRouteError('getCheaterProbability', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    if (error instanceof SteamCallTimeoutError) {
      logRouteError('getCheaterProbability', error, { body });
      return errorResponse(
        'Steam API request timed out. Please try again.',
        504,
        'TIMEOUT',
      );
    }

    if (isSteamResolveFormatError(error)) {
      logRouteError('getCheaterProbability', error, { target: req.url });
      return errorResponse('Invalid target format.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getCheaterProbability', error, { body });
    return errorResponse(
      'Internal server error while querying the prediction model.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
