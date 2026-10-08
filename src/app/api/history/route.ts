import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import checkSameOrigin from '@/lib/watch/csrf';
import {
  deleteSearcherHistory,
  listSearcherSearches,
  parseHistoryCursor,
} from '@/lib/analytics/db';
import { hasAccountFootprint } from '@/lib/watch/searcherAttribution';
import { resolveBotProfileUrl } from '@/lib/watch/botProfile';
import { resolveWatchSession } from '@/lib/watch/session';

export const runtime = 'nodejs';

export const revalidate = 0;

// Same budget as the sibling self-scoped reads (watch/status,
// watch/notifications): one indexed query per hit, cheap by
// construction, same per-instance limiter caveat. GET and DELETE share
// one bucket per IP (documented limitation: a NAT-ed cohort splitting
// reads and clears can 429 itself — accepted, same as every sibling
// route in the repo).
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const historyRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

type SelfSession = { steamId: string };

/**
 * Shared preamble for the self-scoped history lanes (GET reads, DELETE
 * clears): rate limit → forbid ?steamId= → resolve the sealed session.
 * Returns the session SteamID or a ready-to-return Response (429 / 400 /
 * 500 / 401) so neither handler can drift from the contract. The 500
 * text takes the lane ("reading" vs "clearing") so logs stay greppable.
 */
const requireSelfSession = async (
  req: Request,
  action: 'reading' | 'clearing',
): Promise<SelfSession | Response> => {
  if (historyRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  if (new URL(req.url).searchParams.has('steamId')) {
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
    logRouteError('history', sanitizeError(session.error));
    return errorResponse(
      `Internal server error while ${action} search history.`,
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    // 401, never an empty list — that would read as "no history".
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  return { steamId: session.steamId };
};

/**
 * Returns the searches RUN BY the logged-in viewer ("my search
 * history"), newest first — the mirror image of GET
 * /api/watch/notifications (which answers "who searched ME"). Identity
 * comes EXCLUSIVELY from the sealed session cookie: a client-supplied
 * `steamId` is a 400 (forgeable), a missing session is a 401 (never an
 * empty list — that would read as "no history"). Searches recorded while
 * logged out (or before the searcher column existed) carry NULL and
 * never appear here — history starts at login.
 *
 * Path: src/app/api/history/route.ts
 */
export async function GET(req: Request) {
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  const self = await requireSelfSession(req, 'reading');
  if (self instanceof Response) return self;
  const { steamId } = self;
  const params = new URL(req.url).searchParams;

  const rawLimit = params.get('limit');
  let limit: number | undefined;
  if (rawLimit !== null) {
    const parsed = Number(rawLimit);
    if (!Number.isInteger(parsed) || parsed < 1) {
      return errorResponse(
        'Invalid limit: expected a positive integer.',
        400,
        'INVALID_REQUEST',
      );
    }
    limit = parsed;
  }

  // Opaque page bookmark ("searchedAt|searchId", URL-encoded): the client
  // passes back the last row it rendered. Garbage is a 400 (fail fast on
  // caller bugs); absent means the first page. The DAL clamps the limit
  // and revalidates the cursor shape defensively.
  const rawCursor = params.get('cursor');
  const cursor =
    rawCursor === null ? null : parseHistoryCursor(rawCursor);
  if (rawCursor !== null && cursor === null) {
    return errorResponse(
      'Invalid cursor: expected an opaque page bookmark from a previous response.',
      400,
      'INVALID_REQUEST',
    );
  }

  try {
    // Footprint signal for the empty state: a session with no accounts
    // row (opt-out, cookie survived) sees a truthful "you left" copy
    // instead of "no searches yet", which would promise recordings
    // that never come. Computed on the FIRST page only (later pages
    // carry attributing: null and the client reuses page one — same
    // shape discipline as total), in parallel with the page query (the
    // two reads are independent). One indexed PK read per modal open.
    const [page, attributing] = await Promise.all([
      listSearcherSearches(steamId, limit, cursor),
      cursor === null ? hasAccountFootprint(steamId) : null,
    ]);
    return NextResponse.json(
      {
        steamId,
        entries: page.entries,
        // Server-built bookmark (null = exhausted) + first-page total;
        // later pages carry total: null and the client reuses page one.
        nextCursor: page.nextCursor,
        total: page.total,
        attributing,
        // First page, paused state only: the bot-profile link for the
        // reconnect CTA (env-derived, public — the same URL the login
        // waiting room shows). Ships with the same first-page-only
        // discipline as attributing/total; null everywhere else.
        botProfileUrl:
          attributing === false ? resolveBotProfileUrl() : null,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logRouteError('history', sanitizeError(error));
    return errorResponse(
      'Internal server error while reading search history.',
      500,
      'INTERNAL_ERROR',
    );
  }
}

/**
 * Clears the viewer's own history: de-attributes every searches row
 * carrying the session SteamID (SET NULL — the searches themselves stay
 * for aggregates and inboxes, which never show searcher identity).
 * Same self-scoped contract as GET (no ?steamId=, 401 without session),
 * same rate limit: destructive intent, identical cost class.
 */
export async function DELETE(req: Request) {
  if (req.method !== 'DELETE') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  // Second CSRF layer (same as signup/logout): the iron-session cookie
  // is SameSite=Lax (session.ts) so cross-site DELETEs already arrive
  // cookieless — this pins same-origin callers in code anyway. GET stays
  // unchecked (safe method, no state change).
  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  const self = await requireSelfSession(req, 'clearing');
  if (self instanceof Response) return self;

  try {
    const cleared = await deleteSearcherHistory(self.steamId);
    return NextResponse.json(
      { steamId: self.steamId, cleared },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    logRouteError('history', sanitizeError(error));
    return errorResponse(
      'Internal server error while clearing search history.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
