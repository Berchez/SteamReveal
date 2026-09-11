import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import {
  countNotificationsSince,
  listSentNotifications,
} from '@/lib/analytics/db';
import { resolveWatchSession } from '@/lib/watch/session';
import {
  WATCH_INBOX_DEFAULT_LIMIT,
  WATCH_INBOX_MAX_LIMIT,
} from '@/lib/watch/limits';

export const runtime = 'nodejs';

export const revalidate = 0;

// Read-only polling endpoint by design (the inbox fetches on mount and on
// open, no interval polling), so the cap matches the watch/status poll
// budget. One indexed query per hit — cheap by construction. Known,
// accepted limitation shared with every route here: the limiter is
// per-instance in-memory, so multi-instance deploys dilute it (a shared
// KV store is out of scope; the queries themselves stay cheap).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const notificationsRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

const DEFAULT_LIMIT = WATCH_INBOX_DEFAULT_LIMIT;
const MAX_LIMIT = WATCH_INBOX_MAX_LIMIT;

/**
 * Returns the delivered-notification history for a watched profile —
 * exclusively kind='notify' + status='sent' rows (see
 * listSentNotifications: queued/dropped events never render as delivered).
 *
 * Shape: `{ steamId, notifications (newest-first, capped), unreadCount }`.
 * `unreadCount` counts delivered rows past the client-supplied
 * `sinceSentAt` delivery watermark (absent = never opened) WITHOUT the
 * row cap, so the bell stays exact when the backlog exceeds the returned
 * window. The cursor is sent_at, not id: deliveries are not
 * creation-ordered (a requeued retry keeps its old id but lands a fresh
 * sent_at), so an id-cursor would skip late-delivered retries. The client
 * owns the watermark (localStorage, per profile — no `read_at` column);
 * the server only counts past it.
 *
 * Strictly read-only: the inbox presents history, it never creates or
 * mutates notifications. Self-scoped via the Steam OpenID session: each
 * user reads ONLY their own history (the pre-login `?steamId=` parameter
 * is gone — its presence is a 400). Rows carry no PII beyond the
 * requester's own id (delivery timestamps only).
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (notificationsRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const params = new URL(req.url).searchParams;
  if (params.has('steamId')) {
    return errorResponse(
      'Invalid request: steamId comes from the login session, not the query string.',
      400,
      'INVALID_REQUEST',
    );
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('watchNotifications', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while reading notifications.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;

  const rawLimit = params.get('limit');
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return errorResponse(
        'Invalid limit: expected a positive integer.',
        400,
        'INVALID_REQUEST',
      );
    }
    limit = Math.min(parsed, MAX_LIMIT);
  }

  const rawSinceSentAt = params.get('sinceSentAt');
  let sinceSentAt: string | null = null;
  if (rawSinceSentAt !== null) {
    if (!Number.isFinite(Date.parse(rawSinceSentAt))) {
      return errorResponse(
        'Invalid sinceSentAt: expected an ISO-8601 timestamp.',
        400,
        'INVALID_REQUEST',
      );
    }
    sinceSentAt = rawSinceSentAt;
  }

  try {
    const [notifications, unreadCount] = await Promise.all([
      listSentNotifications(steamId, limit),
      countNotificationsSince(steamId, sinceSentAt),
    ]);
    return NextResponse.json(
      { steamId, notifications, unreadCount },
      { status: 200 },
    );
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('watchNotifications', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while reading notifications.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
