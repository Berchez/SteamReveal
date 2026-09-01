import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import isValidTargetParam from '@/lib/isValidTargetParam';
import { errorResponse } from '@/lib/apiError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';

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

type SteamOwnedGameLike = {
  name?: string;
  playtime_forever?: number;
  playtimeForever?: number;
  minutes?: number;
  game?: {
    name?: string;
    playtimeForever?: number;
  };
};

const getGamesSnapshot = (
  games: SteamOwnedGameLike[] | undefined,
): Array<{ name: string; playtimeHours: number }> => {
  if (!Array.isArray(games) || games.length === 0) {
    return [];
  }

  return games
    .map((game) => {
      const name =
        typeof game?.game?.name === 'string' ? game.game.name : game?.name ?? '';
      const playtimeForever = Number(
        game?.playtime_forever ?? game?.playtimeForever ?? game?.minutes ?? 0,
      );
      const playtimeHours =
        Number.isFinite(playtimeForever) && playtimeForever > 0
          ? playtimeForever / 60
          : 0;

      return {
        name,
        playtimeHours: Number((Math.round(playtimeHours * 10) / 10).toFixed(1)),
      };
    })
    .filter((game) => game.name)
    .sort((a, b) => b.playtimeHours - a.playtimeHours);
};

const isCounterStrikeActive = (
  games: Array<{ name: string; playtimeHours: number }> | undefined,
): boolean => {
  if (!games || games.length === 0) {
    return false;
  }

  const csGame = games.find((game) =>
    game.name.toLowerCase().includes('counter-strike'),
  );

  if (csGame && csGame.playtimeHours >= 300) {
    return true;
  }

  return games[0]?.name.toLowerCase().includes('counter-strike') ?? false;
};

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

    const targetInfo = await withTimeout(
      steam.getUserSummary(targetSteamId),
      'getUserInfo: steam.getUserSummary',
      STEAM_CALL_TIMEOUT_MS,
    );

    if (!targetInfo) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    if (typeof steam.getUserOwnedGames === 'function') {
      try {
        const games = await withTimeout(
          steam.getUserOwnedGames(targetSteamId),
          'getUserInfo: steam.getUserOwnedGames',
          STEAM_CALL_TIMEOUT_MS,
        );

        const gamesSnapshot = getGamesSnapshot(
          Array.isArray(games)
            ? games.map((game) => {
                const normalizedGame = game as SteamOwnedGameLike;
                return {
                  name: normalizedGame?.game?.name ?? normalizedGame?.name ?? '',
                  playtime_forever:
                    normalizedGame?.minutes ?? normalizedGame?.playtimeForever ?? 0,
                };
              })
            : [],
        );

        Object.assign(targetInfo, {
          gamesSnapshot,
          isCSActive: isCounterStrikeActive(gamesSnapshot),
        });
      } catch (error) {
        // Best effort: do not fail the profile fetch if the library call for
        // owned games is unavailable, restricted, or temporarily flaky.
        logRouteError('getUserInfo: steam.getUserOwnedGames', error, {
          targetSteamId,
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

    logRouteError('getUserInfo', error, { body });
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
