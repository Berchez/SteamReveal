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
