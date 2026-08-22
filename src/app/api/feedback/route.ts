import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import logRouteError from '@/lib/logRouteError';
import sendFeedbackEmail from './utils';

export const revalidate = 0;

type FeedbackType = 'bug' | 'suggestion' | 'other';

type FeedbackBody = {
  message: string;
  type: FeedbackType;
  page?: string;
  language?: string;
  userAgent?: string;
};

const RATE_LIMIT_WINDOW_MS = 120_000; // 2 min
const RATE_LIMIT_MAX = 3;
const rateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

export async function POST(req: Request) {
  // Standardized order: method check -> rate limit -> parse/validate ->
  // business logic. Rate limit moved before body validation (was after)
  // so it matches getUserInfo/getCloseFriends/getSteamId/
  // getCheaterProbability — every request now consumes rate-limit quota
  // regardless of whether the body turns out to be valid, same as those
  // routes.
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

  try {
    const body = (await req.json()) as FeedbackBody;
    const { message, type, page, language, userAgent } = body;

    if (!message || typeof message !== 'string' || !message.trim()) {
      return errorResponse('Invalid message.', 400, 'INVALID_REQUEST');
    }

    // Limit slightly below UI max to account for multi-byte characters (e.g. emojis)
    if (message.length > 2000) {
      return errorResponse('Message too long.', 413, 'INVALID_REQUEST');
    }

    if (!['bug', 'suggestion', 'other'].includes(type)) {
      return errorResponse('Invalid feedback type.', 400, 'INVALID_REQUEST');
    }

    try {
      await sendFeedbackEmail({
        message,
        type,
        page: page ?? 'unknown',
        language: language ?? 'unknown',
        userAgent: userAgent ?? 'unknown',
      });
    } catch (providerError) {
      logRouteError('feedback', providerError, { type, page });
      return errorResponse(
        'Failed to send feedback email.',
        502,
        'UPSTREAM_ERROR',
      );
    }

    return NextResponse.json(
      { message: 'Feedback sent successfully.' },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      logRouteError('feedback', error);
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }

    logRouteError('feedback', error);
    return errorResponse('Internal server error.', 500, 'INTERNAL_ERROR');
  }
}
