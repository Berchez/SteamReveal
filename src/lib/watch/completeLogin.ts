/**
 * Shared post-friendship login completion — the SINGLE implementation of
 * the load-bearing order, used by BOTH production login paths (the OpenID
 * callback for already-friends, the pending route for the waiting room).
 * A second inline copy lived in each route before; any future change to
 * this order must land here once, never drift between two call sites.
 *
 * Order (load-bearing): ensureActiveWatch (fatal) -> recordLogin (audit,
 * non-fatal) -> saveWatchSession (fatal) -> login_completed funnel event
 * (non-fatal) -> welcome once if activated (non-fatal, retried).
 *
 * The seal sits BEFORE the welcome on purpose: nothing the welcome needs
 * depends on it, and this ordering closes the orphan-welcome window
 * entirely — a seal failure can never strand an already-sent welcome
 * (the user would see an error while holding a live watch), and every
 * welcomed user is guaranteed sealed. The reverse order (welcome first)
 * would keep that window open on both callers for zero benefit.
 *
 * Fatal vs non-fatal contract:
 * - ensureActiveWatch / saveWatchSession THROW: the watch row is the
 *   load-bearing state and the seal is the login itself — callers deny
 *   (callback) or keep waiting (pending route) on these.
 * - recordLogin / welcome NEVER throw out of here: a failed audit write
 *   costs a log line, and a lost welcome is preferable to a lost login
 *   (the welcome has no backstop once the row is active — hence the
 *   retries — but login > welcome regardless).
 *
 * `routeName` scopes the log lines to the calling route (the helper must
 * never guess which path it serves — the two callers fail differently).
 */

import type { CookieStore } from 'iron-session';

import {
  enqueueEvent,
  ensureActiveWatch,
  recordLogin,
  recordLoginFunnelEvent,
} from '@/lib/analytics/db';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { readLoginCtxFromStore } from '@/lib/analytics/loginFunnelCookie';
import withTimeout from '@/lib/withTimeout';

import { localeFromNextPath } from './loginNext';
import { saveWatchSession } from './session';

/**
 * Welcome-enqueue retries (mirrors the confirm route's 3-attempt
 * discipline): a single DB blip must not silently eat the only welcome
 * — nothing re-emits it later (reconcile only activates pending rows;
 * this row is already active).
 */
export const WELCOME_ATTEMPTS = 3;

/**
 * Ceiling for the funnel write on the login path. Awaits are load-bearing
 * here (Next 14.2 has no after()/waitUntil — see the rationale in
 * recordAnalytics route.ts — a floating promise may never run once the
 * serverless function returns), so this cannot be fire-and-forget. But an
 * UNBOUNDED await would let a stalled Turso connection hold the user's
 * login-completion redirect hostage, so it gets the same treatment as the
 * dashboard's funnel read: awaited, non-fatal, capped. 4s mirrors that
 * budget — far above a single-row INSERT, instant to lose.
 */
const LOGIN_FUNNEL_WRITE_TIMEOUT_MS = 4_000;

export interface CompleteLoginResult {
  /** True when THIS call newly activated the row (the only case a welcome is owed). */
  activated: boolean;
  /** Locale resolved from `next` for the watch/login rows (null → English fallback downstream). */
  locale: string | null;
}

export const completeProvenLogin = async (
  cookieStore: CookieStore,
  steamId: string,
  next: string,
  routeName: string,
): Promise<CompleteLoginResult> => {
  const locale = localeFromNextPath(next);
  const { activated } = await ensureActiveWatch(steamId, locale);
  // Login registry (ops audit): non-fatal by contract — a failed audit
  // write costs a log line, never the login (the watch row above is the
  // load-bearing state; this row only answers "who logs in, when").
  try {
    await recordLogin(steamId, locale);
  } catch (error) {
    logRouteError(`${routeName}:recordLogin`, sanitizeError(error), {
      steamId,
    });
  }

  // Seal BEFORE the welcome (see the order rationale above): from here on
  // the user is logged in, so a welcome failure below degrades to a
  // missing chat message, never to a confusing state.
  await saveWatchSession(cookieStore, steamId);

  // Login-funnel completion (analytics only, never auth logic): pairs with
  // the navbar's `login_cta_clicked` beacon via the CTA cookie the click
  // planted. Non-fatal by the same contract as recordLogin above — a
  // failed funnel write costs a log line, never the login. Runs on BOTH
  // production login paths (callback + waiting-room pending) because both
  // funnel through here; a missing/unreadable cookie records NULLs
  // (volume counts, excluded from the per-session conversion rate).
  // Awaited (no after() on Next 14.2 — a floating promise dies with the
  // serverless function) but capped by LOGIN_FUNNEL_WRITE_TIMEOUT_MS so a
  // stalled write costs at most 4s of redirect latency, never the request.
  try {
    const ctx = readLoginCtxFromStore(cookieStore);
    await withTimeout(
      recordLoginFunnelEvent({
        event: 'login_completed',
        sessionId: ctx.sessionId,
        searchId: ctx.searchId,
      }),
      `${routeName}:loginFunnel`,
      LOGIN_FUNNEL_WRITE_TIMEOUT_MS,
    );
  } catch (error) {
    logRouteError(`${routeName}:loginFunnel`, sanitizeError(error), {
      steamId,
    });
  }

  // Welcome once: ONLY the call that actually flipped the row (fresh
  // insert or confirmed/grandfathered pending flip) enqueues it —
  // idempotent re-logins and confirm-lane preservations stay silent.
  // Retried; still non-fatal (login > welcome).
  if (activated) {
    let welcomed = false;
    for (let attempt = 0; attempt < WELCOME_ATTEMPTS && !welcomed; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await enqueueEvent(steamId, 'welcome');
        welcomed = true;
      } catch (error) {
        logRouteError(`${routeName}:welcome`, sanitizeError(error), {
          steamId,
          attempt: attempt + 1,
        });
      }
    }
  }

  return { activated, locale };
};
