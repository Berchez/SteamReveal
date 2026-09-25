import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import isValidTargetParam from '@/lib/isValidTargetParam';
import { errorResponse } from '@/lib/apiError';
import isBenignOwnedGamesError from '@/lib/isBenignOwnedGamesError';
import isSteamProfileNotFoundError from '@/lib/isSteamProfileNotFoundError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
import {
  CS_ACTIVE_ENRICHMENT_TIMEOUT_MS,
  getGamesSnapshot,
  isCounterStrikeActive,
} from '@/app/templates/Home/shared/analytics/homeAnalyticsUtils';

export const revalidate = 0;

const steamApiKey = getSteamApiKey();
if (!steamApiKey) {
  // eslint-disable-next-line no-console
  console.error(
    'getUserInfo - STEAM_API_KEY is missing at module init. Every request to this route will fail until it is set.',
  );
}
const steam = new SteamAPI(steamApiKey ?? '');

const STEAM_CALL_TIMEOUT_MS = 8000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function POST(req: Request) {
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  // Dev/test mode short-circuit: only taken when isMockModeEnabled() also
  // agrees (never NODE_ENV=production, never on Vercel). If DEV_TEST_MODE
  // is set but the guard fails, fall through to the real implementation
  // instead of erroring — a stray env var must never be able to take
  // production down.
  if (process.env.DEV_TEST_MODE === '1') {
    const { isMockModeEnabled, makeMockProfile, isMockInvalidTarget } =
      await import('@/mocks/devFixtures');

    if (isMockModeEnabled()) {
      try {
        const body = await req.json();
        const { target } = body;
        if (!target || !isValidTargetParam(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        if (isMockInvalidTarget(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        const targetInfo = makeMockProfile(target);
        return NextResponse.json({ targetInfo }, { status: 200 });
      } catch (e) {
        return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
      }
    }
    // Guard failed: fall through to the real implementation below.
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

    const { target } = body;

    if (!isValidTargetParam(target)) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    const targetSteamId = await withTimeout(
      steam.resolve(target),
      'getUserInfo: steam.resolve',
      STEAM_CALL_TIMEOUT_MS,
    );

    // The owned-games enrichment is optional (it only feeds the CS-active +
    // analytics cost gate) and can be slow for large libraries due to
    // `includeAppInfo: true`, so it fires in parallel with the summary and is
    // bounded by a short dedicated timeout — it must never hold up the
    // user-card response that drives LCP/CLS.
    let ownedGamesPromise:
      | Promise<
          | Array<{ name?: string; playtime_forever?: number; minutes?: number }>
          | null
        >
      | undefined;
    if (typeof steam.getUserOwnedGames === 'function') {
      ownedGamesPromise = withTimeout(
        steam.getUserOwnedGames(targetSteamId, { includeAppInfo: true }),
        'getUserInfo: steam.getUserOwnedGames',
        CS_ACTIVE_ENRICHMENT_TIMEOUT_MS,
      ).catch((error) => {
        // Best effort: a failure here must never fail the profile fetch. It
        // only leaves isCSActive/gamesSnapshot off the response (the prefetch
        // gate treats unknown as "don't spend"). Data-unavailability shapes
        // (private library, bogus/gone profile — see
        // isBenignOwnedGamesError) log at warn: they are user-triggerable
        // and routine, not incidents. Everything else stays loud so
        // rate-limit/provider issues remain observable.
        if (isBenignOwnedGamesError(error)) {
          // eslint-disable-next-line no-console
          console.warn(
            `getUserInfo: owned-games lookup unavailable for ${targetSteamId} (private library or unresolvable profile):`,
            error instanceof Error ? error.message : error,
          );
        } else {
          logRouteError('getUserInfo: steam.getUserOwnedGames', error, {
            targetSteamId,
          });
        }
        return null;
      });
    }

    const targetInfo = await withTimeout(
      steam.getUserSummary(targetSteamId),
      'getUserInfo: steam.getUserSummary',
      STEAM_CALL_TIMEOUT_MS,
    );

    if (!targetInfo) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    if (ownedGamesPromise) {
      const games = await ownedGamesPromise;
      if (games) {
        const gamesSnapshot = getGamesSnapshot(games);
        Object.assign(targetInfo, {
          gamesSnapshot,
          isCSActive: isCounterStrikeActive(gamesSnapshot),
        });
      }
    }

    return NextResponse.json({ targetInfo }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('getUserInfo', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    if (error instanceof SteamCallTimeoutError) {
      logRouteError('getUserInfo', error, { body });
      return errorResponse(
        'Steam API request timed out. Please try again.',
        504,
        'TIMEOUT',
      );
    }

    if (isSteamResolveFormatError(error)) {
      logRouteError('getUserInfo', error, { target: req.url });
      return errorResponse('Invalid target format.', 400, 'INVALID_REQUEST');
    }

    if (isSteamProfileNotFoundError(error)) {
      // In-range ID that Steam says doesn't exist: same client outcome as
      // any invalid target (invalidPlayer toast), but an honest 400
      // instead of a 500 that reads like an incident in the ops log.
      // Client input, not a server failure — stays unlogged, like the
      // other invalid-target 400s above.
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    logRouteError('getUserInfo', error, { body });
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
