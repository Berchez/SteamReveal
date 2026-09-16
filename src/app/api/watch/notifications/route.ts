import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import {
  countSearchesInMonth,
  countSearchesSince,
  getWatchedProfile,
  listProfileSearches,
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
 * Returns the search history on a watched profile — EVERY recorded search,
 * newest first, with no cooldown gate. The bot keeps its own strict 24h
 * delivery discipline at send time (see watchNotify + notifyPoller); this
 * route is the relaxed side: cooldown-suppressed views still appear here,
 * because "who looked me up" must not hide behind a delivery throttle.
 *
 * Shape: `{ steamId, notifications (newest-first, capped), unreadCount,
 * monthlyCount }`.
 * `unreadCount` counts recorded searches past the client-supplied
 * `sinceSearchedAt` search watermark (absent = never opened) WITHOUT the
 * row cap, so the bell stays exact when the backlog exceeds the returned
 * window. The cursor is searched_at, not any id: search ids embed
 * wall-clock plus randomness, so they are not strictly ordered. The
 * client owns the watermark (localStorage, per profile — no `read_at`
 * column); the server only counts past it. The legacy `sinceSentAt`
 * parameter is still accepted as an alias — pre-split stored watermarks
 * are full ISO timestamps, so they compare correctly as search cursors.
 * `monthlyCount` counts recorded searches on this profile since the start
 * of the current UTC month (cooldown-suppressed views included) for the
 * inbox header badge.
 *
 * All three reads share one temporal floor — the watch's activated_at
 * (requested_at while still pending): pre-watch searches never appear, so
 * a new confirmer starts from a clean history instead of inheriting
 * strangers' lookups that predate the opt-in. No watch row at all (never
 * requested, or opted out — opt-out deletes the row) answers an empty
 * inbox without touching the search tables: "no row" means "no inbox".
 *
 * Strictly read-only: the inbox presents history, it never creates or
 * mutates notifications. Self-scoped via the Steam OpenID session: each
 * user reads ONLY their own history (the pre-login `?steamId=` parameter
 * is gone — its presence is a 400). Rows carry no PII beyond the
 * requester's own id (search timestamps + the profile's own search
 * metadata — viewed-at, cheater flag — never requester geo/device).
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

  // sinceSearchedAt is the current name; sinceSentAt is the pre-split
  // alias (same ISO-cursor semantics — see the docblock). sinceSearchedAt
  // wins when both travel (the client only ever sends one); either alone
  // behaves identically.
  const rawSince = params.get('sinceSearchedAt') ?? params.get('sinceSentAt');
  let sinceSearchedAt: string | null = null;
  if (rawSince !== null) {
    if (!Number.isFinite(Date.parse(rawSince))) {
      return errorResponse(
        'Invalid sinceSearchedAt: expected an ISO-8601 timestamp.',
        400,
        'INVALID_REQUEST',
      );
    }
    sinceSearchedAt = rawSince;
  }

  try {
    // No watch row (never requested, or opted out — opt-out DELETES the
    // row) means an empty inbox, full stop. searches is shared site
    // analytics, so falling through to an unfiltered read here would leak
    // the profile's whole lookup history to someone who never opted in —
    // and worse, would show a post-opt-out user MORE history than they
    // saw while watched (the row deletion would lift the floor). Watch
    // is opt-in everywhere else in the product; "no row" means "no
    // inbox", not "no limit". Answered without touching the search
    // tables at all.
    const watched = await getWatchedProfile(steamId);
    if (watched === null) {
      return NextResponse.json(
        { steamId, notifications: [], unreadCount: 0, monthlyCount: 0 },
        { status: 200 },
      );
    }
    // Temporal floor: searches is shared site analytics — every lookup of
    // any profile lands there, including ones from before this watch
    // existed. Without the floor, a first-time confirmer would inherit
    // months of strangers' pre-opt-in lookups (and a misleading monthly
    // badge). activated_at marks when monitoring actually started;
    // requested_at is the fallback for still-pending watches.
    const watchStart = watched.activatedAt ?? watched.requestedAt;
    const [notifications, unreadCount, monthlyCount] = await Promise.all([
      listProfileSearches(steamId, limit, watchStart),
      countSearchesSince(steamId, sinceSearchedAt, watchStart),
      countSearchesInMonth(steamId, Date.now(), watchStart),
    ]);
    return NextResponse.json(
      { steamId, notifications, unreadCount, monthlyCount },
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
