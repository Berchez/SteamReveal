import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { isSteamId64 } from '@/lib/steamId';
import INVITE_REREQUEST_AFTER_MS from '@/lib/watchInviteCooldown';
import {
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
const requestRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

// A row this request created/refreshed moments ago (see below).
const FRESH_ROW_MAX_AGE_MS = 60000;

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
    logRouteError('watchRequest', sanitizeError(error), {
      steamId,
      stage,
      rolledBack,
    });
    return false;
  }
};

type WatchRequestBody = {
  steamId?: unknown;
  locale?: unknown;
};

/**
 * Starts (or resumes) bot-friendship verification for a Steam profile.
 *
 * Always 200 on a handled request — duplicates and cooldowns are answers,
 * not errors:
 * - new request            -> { status: 'pending', inviteQueued: true }
 * - pending, within 7 days -> { status: 'pending', inviteQueued: false, pendingExpiresInMs }
 * - pending, expired        -> { status: 'pending', inviteQueued: true } (clock restarted)
 * - already active          -> { status: 'active', inviteQueued: false }
 *
 * Field semantics (read this before consuming): `inviteQueued: true` means
 * an invite send is now pending for this profile as a result of this call
 * — either freshly queued, or confirmed still open via the DAL collapse
 * (concurrent duplicate). `pendingExpiresInMs` is the remaining validity
 * of the current pending window: the caller needs no polling, the bot acts
 * on its own; after expiry a re-request re-opens the window.
 *
 * No login required by design (Epic 2 decision): the friendship acceptance
 * itself is the opt-in proof, so requesting an invite for someone else's
 * profile is harmless — they simply ignore it and nothing activates.
 */
export async function POST(req: Request) {
  // App Router only routes POST here; kept as defense-in-depth (and so unit
  // tests can invoke POST() directly with other methods).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (requestRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  let body: WatchRequestBody;
  try {
    body = (await req.json()) as WatchRequestBody;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return errorResponse('Malformed JSON body.', 400, 'INVALID_REQUEST');
    }
    logRouteError('watchRequest', sanitizeError(error));
    return errorResponse(
      'Internal server error while requesting watch.',
      500,
      'INTERNAL_ERROR',
    );
  }

  const { steamId, locale } = body ?? {};
  if (!isSteamId64(steamId)) {
    return errorResponse(
      'Invalid steamId: expected 17-digit SteamID64.',
      400,
      'INVALID_REQUEST',
    );
  }
  const localeString = typeof locale === 'string' ? locale : null;

  try {
    const existing = await getWatchedProfile(steamId);

    if (!existing) {
      await createWatchRequest(steamId, localeString);
      if (!(await tryEnqueueInvite(steamId, 'enqueue-after-create'))) {
        return errorResponse(
          'Internal server error while requesting watch.',
          500,
          'INTERNAL_ERROR',
        );
      }
      return NextResponse.json(
        {
          steamId,
          status: 'pending',
          inviteQueued: true,
          pendingExpiresInMs: null,
        },
        { status: 200 },
      );
    }

    if (existing.status === 'active') {
      return NextResponse.json(
        {
          steamId,
          status: 'active',
          inviteQueued: false,
          pendingExpiresInMs: null,
        },
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
          steamId,
          status: 'pending',
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
    const refreshed = await refreshWatchRequest(steamId, localeString);
    if (!refreshed) {
      const current = await getWatchedProfile(steamId);
      if (current?.status === 'active') {
        return NextResponse.json(
          {
            steamId,
            status: 'active',
            inviteQueued: false,
            pendingExpiresInMs: null,
          },
          { status: 200 },
        );
      }
      // Row vanished (opt-out race): start over as a brand-new request.
      await createWatchRequest(steamId, localeString);
    }
    if (!(await tryEnqueueInvite(steamId, 'enqueue-after-refresh'))) {
      return errorResponse(
        'Internal server error while requesting watch.',
        500,
        'INTERNAL_ERROR',
      );
    }
    return NextResponse.json(
      {
        steamId,
        status: 'pending',
        inviteQueued: true,
        pendingExpiresInMs: null,
      },
      { status: 200 },
    );
  } catch (error) {
    // steam_id is public data (searchable on the site), safe to log.
    logRouteError('watchRequest', sanitizeError(error), { steamId });
    return errorResponse(
      'Internal server error while requesting watch.',
      500,
      'INTERNAL_ERROR',
    );
  }
}
