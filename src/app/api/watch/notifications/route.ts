import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import {
  ANTI_LOOP_TOKEN_BYTES,
  ANTI_LOOP_TOKEN_TTL_MS,
  countSearchesInMonth,
  countSearchesSince,
  getWatchedProfile,
  hashAntiLoopToken,
  issueAntiLoopTokenIfAbsent,
  listProfileSearches,
} from '@/lib/analytics/db';
import { generateHexToken } from '@/lib/watch/tokens';
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

// The success body may carry a raw single-use token: intermediaries must
// never cache it (a cached copy would serve a consumed token — or worse,
// someone else's — to later visitors).
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

/**
 * Returns the search history on a watched profile — EVERY recorded search,
 * newest first, with no cooldown gate. The bot keeps its own strict 24h
 * delivery discipline at send time (see watchNotify + notifyPoller); this
 * route is the relaxed side: cooldown-suppressed views still appear here,
 * because "who looked me up" must not hide behind a delivery throttle.
 *
 * Shape: `{ steamId, notifications (newest-first, capped), unreadCount,
 * monthlyCount, antiLoopToken }` (`antiLoopToken` is a freshly minted
 * single-use token for the inbox "see what they saw" links — null when a
 * bot-chat link is still outstanding, when minting failed, or when the
 * client did not ask for links).
 *
 * `?withToken=1` (exact match, anything else ignored): the client sends it
 * only on fetches whose rows will actually RENDER as links (panel open /
 * retry) — never on the mount fetch that feeds just the bell badge. A
 * blind UPDATE per page load would be pure waste against the unique
 * index, and delay the badge by a round trip for nothing. The mint itself
 * is described below.
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
 * Almost read-only, with one disclosed exception: `?withToken=1` arms a
 * loop-guard token (single idempotent-if-absent UPDATE, described above).
 * This is NOT the QA-08/QA-39 principle (those forbid GETs that SPEND
 * confirm tokens / activate watches — destructive consumes): minting
 * constructs, never destroys — the worst case is an unused token sitting
 * 24h, exactly like the bot's own unclicked chat links. Prefetch/crawler
 * exposure is nil by construction: the endpoint needs the victim's live
 * session (401 otherwise — link prefetchers never carry it), and a blind
 * hit would only arm, never spend. Self-scoped via the Steam OpenID
 * session: each user reads ONLY their own history (the pre-login
 * `?steamId=` parameter is gone — its presence is a 400). Rows carry no
 * PII beyond the requester's own id (search timestamps + the profile's
 * own search metadata — viewed-at, cheater flag — never requester
 * geo/device).
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

  // Link-token hint (exact '1' only — anything else is ignored, never a
  // 400: this is progressive enhancement, not a contract). See the
  // docblock for why the client sends it solely on link-rendering fetches.
  const wantToken = params.get('withToken') === '1';

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
        {
          steamId,
          notifications: [],
          unreadCount: 0,
          monthlyCount: 0,
          antiLoopToken: null,
        },
        { status: 200, headers: NO_STORE_HEADERS },
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
    // Self-click loop guard: the inbox "see what they saw" links open the
    // owner's own profile, which would otherwise record a fresh search and
    // notify again (inbox + a new bot message per click). The player page
    // already forwards ?anti_loop_token= into recordAnalytics, so handing
    // the inbox a token closes the loop with zero player-page changes.
    // Mint ONLY when asked (?withToken=1, i.e. rows will render as links)
    // and rows exist. Accepted write cost, recorded deliberately: one
    // indexed UPDATE...RETURNING per panel open (no-op when the slot is
    // held — but the round trip still runs). Never on the mount fetch,
    // which is why the badge path stays a pure read.
    // The issue itself is atomic-if-absent (same statement
    // checks the live predicate — no read-then-write window for the bot's
    // own issue to slip through): a lost race resolves to false (hands off
    // the outstanding bot-chat link — its raw value is hash-only at rest
    // and unrecoverable) instead of silently killing it. One shared token
    // for all rows. Every failure mode below degrades to null (plain links
    // = today's behavior, never worse, never a 500) — but loudly: a mint
    // that keeps failing is a sick DAL nobody would otherwise ever see.
    // (Known residual, bounded by the 24h notify cooldown: reopening the
    // panel without clicking leaves our own unconsumed token live, so the
    // next open gets null until it is consumed or expires. A separate
    // inbox-only slot would fix that at the cost of a migration —
    // deliberately not taken for this edge.)
    let antiLoopToken: string | null = null;
    if (wantToken && notifications.length > 0) {
      try {
        const raw = generateHexToken(ANTI_LOOP_TOKEN_BYTES);
        const issued = await issueAntiLoopTokenIfAbsent(
          steamId,
          hashAntiLoopToken(raw),
          new Date(Date.now() + ANTI_LOOP_TOKEN_TTL_MS).toISOString(),
        );
        if (issued) antiLoopToken = raw;
      } catch (error) {
        // Raw error (not sanitizeError(error)): logRouteError derives the
        // message AND captures error.stack for the file log — pre-sanitizing
        // here would stringify it and silently drop the stack (the boundary
        // sanitize inside writeOpsLog still applies).
        logRouteError('watchNotifications:antiLoopMint', error, { steamId });
        antiLoopToken = null;
      }
    }
    return NextResponse.json(
      { steamId, notifications, unreadCount, monthlyCount, antiLoopToken },
      { status: 200, headers: NO_STORE_HEADERS },
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
