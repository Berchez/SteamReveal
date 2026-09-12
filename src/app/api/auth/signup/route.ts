import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import checkSameOrigin from '@/lib/watch/csrf';
import { resolveWatchSession } from '@/lib/watch/session';
import INVITE_REREQUEST_AFTER_MS from '@/lib/watchInviteCooldown';
import {
  createAccount,
  createWatchRequest,
  deactivateWatch,
  enqueueEvent,
  getWatchedProfile,
  hasOpenInviteEvent,
  refreshWatchRequest,
} from '@/lib/analytics/db';

export const runtime = 'nodejs';

export const revalidate = 0;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
// Same cheap-flood budget as the other authenticated POST routes: the
// limiter only sheds junk traffic, never guards correctness (the invite
// discipline lives in the DAL branch below, not here).
const signupRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

// A row this request created/refreshed moments ago (see below).
const FRESH_ROW_MAX_AGE_MS = 60000;

type SignupBody = {
  locale?: unknown;
};

/**
 * Removes a just-written pending row when its invite enqueue failed.
 * Without this, the row would sit fresh-pending for 7 days refusing
 * re-queues while no invite was ever queued — a silent dead end. Only
 * touches rows plausibly written by this very request (still pending AND
 * requested within the last minute) AND with no open invite event (a
 * concurrent request may have queued a valid invite after our enqueue
 * failed — deleting then would orphan it: accepted invite, no row to
 * activate, silent loss). Anything else is someone else's state — hands
 * off. Never throws (compensation must not mask the original error).
 */
const compensateFailedEnqueue = async (steamId: string): Promise<boolean> => {
  try {
    const current = await getWatchedProfile(steamId);
    if (current === null || current.status !== 'pending') return false;
    const requestedMs = Date.parse(current.requestedAt);
    if (!Number.isFinite(requestedMs)) return false;
    if (Date.now() - requestedMs >= FRESH_ROW_MAX_AGE_MS) return false;
    if (await hasOpenInviteEvent(steamId)) return false;
    return await deactivateWatch(steamId);
  } catch {
    return false;
  }
};

/**
 * Enqueues the invite, compensating on failure (see above). Returns false
 * when the invite is NOT queued — callers answer 500. Logs the failure
 * loudly with the stage and whether the rollback happened, so the
 * inconsistent state (if rollback was impossible) is visible instead of
 * collapsing into a generic 500.
 */
const tryEnqueueInvite = async (
  steamId: string,
  stage: 'enqueue-after-create' | 'enqueue-after-refresh',
): Promise<boolean> => {
  try {
    await enqueueEvent(steamId, 'invite');
    return true;
  } catch (error) {
    const rolledBack = await compensateFailedEnqueue(steamId);
    logRouteError('authSignup', sanitizeError(error), {
      steamId,
      stage,
      rolledBack,
    });
    return false;
  }
};

/**
 * Registers the LOGGED-IN profile for Watch (navbar-global signup).
 *
 * Identity comes EXCLUSIVELY from the Steam OpenID session (401 without
 * one); `locale` rides the body for the bot's message language. One call
 * performs the whole chain; every step is safe to repeat.
 *
 * Invite discipline (ported from the retired watch/request route — the
 * DAL collapse alone is NOT enough: it only dedupes while a previous
 * invite is still open, so without this guard every repeat signup after a
 * send would burn one of the bot's 50/day global invites):
 * - no watch row          -> create + enqueue (inviteQueued: true)
 * - active                -> NO enqueue, the friendship already exists
 *                           (inviteQueued: false)
 * - pending, within 7d    -> NO enqueue, previous invite still valid
 *                           (inviteQueued: false + pendingExpiresInMs)
 * - pending, expired       -> refresh clock + enqueue (inviteQueued: true)
 *
 * Deliberately issues NO confirmation token: the bot is the sole issuer,
 * at activation time (the exact moment the link becomes deliverable over
 * chat). A route-issued token would have no sender — and two writers
 * would break the single-outstanding-token invariant the atomic consume
 * relies on. Accept the bot invite; the link arrives right after.
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (signupRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  const session = await resolveWatchSession(cookies());
  if (session.status === 'error') {
    logRouteError('authSignup', sanitizeError(session.error));
    return errorResponse(
      'Internal server error while signing up.',
      500,
      'INTERNAL_ERROR',
    );
  }
  if (session.status === 'unauthenticated') {
    return errorResponse('Login required.', 401, 'UNAUTHENTICATED');
  }
  const { steamId } = session;

  let body: SignupBody;
  try {
    body = (await req.json()) as SignupBody;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }
    logRouteError('authSignup', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while signing up.',
      500,
      'INTERNAL_ERROR',
    );
  }
  // Self-scoped, strictly (ported from the retired watch/request route): a
  // client-supplied steamId is a stale pre-login caller (or worse) — reject
  // loudly instead of ignoring it. Identity comes from the session only.
  // Validated before reading anything else out of the body.
  if (body !== null && typeof body === 'object' && 'steamId' in body) {
    return errorResponse(
      'Invalid request body: steamId comes from the login session, not the client.',
      400,
      'INVALID_REQUEST',
    );
  }
  const locale = body !== null && typeof body === 'object' && typeof (body as SignupBody).locale === 'string'
    ? ((body as SignupBody).locale as string)
    : null;

  try {
    // The account row always exists after signup (INSERT OR IGNORE — a
    // re-signup never touches confirmation state); the watch row below
    // decides whether an invite goes out.
    await createAccount(steamId, locale);
    const existing = await getWatchedProfile(steamId);

    if (existing === null) {
      await createWatchRequest(steamId, locale);
      if (!(await tryEnqueueInvite(steamId, 'enqueue-after-create'))) {
        return errorResponse(
          'Internal server error while signing up.',
          500,
          'INTERNAL_ERROR',
        );
      }
      return NextResponse.json(
        { ok: true, steamId, inviteQueued: true, pendingExpiresInMs: null },
        { status: 200 },
      );
    }

    if (existing.status === 'active') {
      return NextResponse.json(
        { ok: true, steamId, inviteQueued: false, pendingExpiresInMs: null },
        { status: 200 },
      );
    }

    // Pending: only re-queue once the previous invite expired. A corrupt
    // requested_at fails open toward re-queueing (one extra invite event,
    // harmless and Steam-side idempotent) rather than locking the user out.
    const elapsedMs = Date.now() - Date.parse(existing.requestedAt);
    if (Number.isFinite(elapsedMs) && elapsedMs < INVITE_REREQUEST_AFTER_MS) {
      return NextResponse.json(
        {
          ok: true,
          steamId,
          inviteQueued: false,
          pendingExpiresInMs: INVITE_REREQUEST_AFTER_MS - elapsedMs,
        },
        { status: 200 },
      );
    }

    // The refresh can lose a race (activated or removed concurrently):
    // a false return means "not pending anymore", so re-read and answer
    // the truth instead of enqueueing blind into a changed state. The
    // current locale rides along so a re-request from a new browser
    // language updates the bot's message language.
    const refreshed = await refreshWatchRequest(steamId, locale);
    if (!refreshed) {
      const current = await getWatchedProfile(steamId);
      if (current?.status === 'active') {
        return NextResponse.json(
          { ok: true, steamId, inviteQueued: false, pendingExpiresInMs: null },
          { status: 200 },
        );
      }
      // Row vanished (opt-out race): start over as a brand-new request.
      await createWatchRequest(steamId, locale);
    }
    if (!(await tryEnqueueInvite(steamId, 'enqueue-after-refresh'))) {
      return errorResponse(
        'Internal server error while signing up.',
        500,
        'INTERNAL_ERROR',
      );
    }
    return NextResponse.json(
      { ok: true, steamId, inviteQueued: true, pendingExpiresInMs: null },
      { status: 200 },
    );
  } catch (error) {
    // steamId is public data (searchable on the site), safe to log.
    logRouteError('authSignup', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while signing up.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
