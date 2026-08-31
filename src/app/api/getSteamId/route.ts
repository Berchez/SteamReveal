import getSteamApiKey from '@/lib/getSteamApiKey';
import { NextResponse } from 'next/server';
import SteamAPI from 'steamapi';
import isValidTargetParam from '@/lib/isValidTargetParam';
import isSteamResolveFormatError from '@/lib/isSteamResolveFormatError';
import { errorResponse } from '@/lib/apiError';
import withTimeout, { SteamCallTimeoutError } from '@/lib/withTimeout';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';

export const revalidate = 0;

const steamApiKey = getSteamApiKey();
if (!steamApiKey) {
  console.error(
    'getSteamId - STEAM_API_KEY is missing at module init. Every request to this route will fail until it is set.',
  );
}
const steam = new SteamAPI(steamApiKey ?? '');

const STEAM_CALL_TIMEOUT_MS = 8000;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function GET(req: Request) {
  // Dev/test mode: deterministic steamId, but ONLY when the extra
  // isMockModeEnabled() guard also agrees (never NODE_ENV=production,
  // never on Vercel). If DEV_TEST_MODE is set but the guard fails, we
  // deliberately fall through to the real Steam call below instead of
  // erroring out — a stray env var must never be able to take prod down.
  if (process.env.DEV_TEST_MODE === '1') {
    const { isMockModeEnabled, isMockInvalidTarget } = await import(
      '@/mocks/devFixtures'
    );

    if (isMockModeEnabled()) {
      try {
        const { searchParams } = new URL(req.url);
        const target = searchParams.get('target');
        if (!target || !isValidTargetParam(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        if (isMockInvalidTarget(target)) {
          return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
        }
        return NextResponse.json({ steamId: target }, { status: 200 });
      } catch (e) {
        return errorResponse('Invalid request.', 400, 'INVALID_REQUEST');
      }
    }
    // Guard failed: fall through to the real implementation below.
  }

  // GET has no method branch needed (Next.js only invokes this handler
  // for GET), so the standardized order here starts at rate limit.
  const ip = getRequestIp(req);
  if (rateLimiter.isRateLimited(ip)) {
    return errorResponse(
      'Too many requests. Try again later.',
      429,
      'RATE_LIMITED',
    );
  }

  try {
    const { searchParams } = new URL(req.url);
    const target = searchParams.get('target');

    if (!isValidTargetParam(target)) {
      return errorResponse('Invalid target.', 400, 'INVALID_REQUEST');
    }

    const targetSteamId = await withTimeout(
      steam.resolve(target),
      'getSteamId: steam.resolve',
      STEAM_CALL_TIMEOUT_MS,
    );

    return NextResponse.json({ steamId: targetSteamId }, { status: 200 });
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('getSteamId', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    if (isSteamResolveFormatError(error)) {
      logRouteError('getSteamId', error, { target: req.url });
      return errorResponse('Invalid target format.', 400, 'INVALID_REQUEST');
    }

    if (error instanceof SteamCallTimeoutError) {
      logRouteError('getSteamId', error);
      return errorResponse(
        'Steam API request timed out. Please try again.',
        504,
        'TIMEOUT',
      );
    }

    logRouteError('getSteamId', error);
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
