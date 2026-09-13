import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { saveWatchSession } from '@/lib/watch/session';
import { resolveLocaleHome } from '@/lib/watch/loginNext';
import {
  consumeConfirmToken,
  getAccount,
  hashConfirmToken,
} from '@/lib/analytics/db';

export const runtime = 'nodejs';

export const revalidate = 0;

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
// Token space is 256-bit (unguessable), so this cap is only anti-noise:
// it keeps a blind prober from churning DB reads, nothing more.
const confirmRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX,
);

/**
 * Consumes a bot-delivered confirmation link (`?token=<hex>`).
 *
 * Deliberately works LOGGED OUT (no session required): proving access to
 * the Steam account's chat IS the confirmation, so demanding a prior
 * login would deadlock users whose cookie expired between signup and the
 * click. On success it ALSO seals the session — the click doubles as
 * login — and redirects to the LOCALE home for the success toast (the
 * stored signup locale, so the landing needs no middleware locale
 * re-detection hop to show the right language). Invalid, expired, or
 * already-consumed tokens land on the same error redirect WITHOUT
 * distinguishing which (no oracle for probers: every failure looks
 * identical).
 *
 * Conscious trade-off (login-by-link): the sealed session is a bearer
 * credential scoped to watch-only identity (30-day sealed cookie carrying
 * just `{ steamId, expiresAt }` — no broader account powers exist to
 * borrow). Anyone holding the link (forward, screenshot, overlay log)
 * confirms AND logs in as that profile. Accepted: the link IS the
 * proof-of-ownership factor here, and there is nothing more privileged
 * for a borrowed session to reach.
 *
 * Risk note (parallel to anti_loop_token): chat linkifiers, antivirus
 * URL-scanning, and browser prefetch all perform GET requests on links
 * before the user explicitly clicks. If any of these "consumes" the
 * token before the real click, the user lands on the error page without
 * ever having confirmed — and the token is already spent (re-emit only
 * on next signup activation). This is an accepted trade-off for the
 * one-shot login-by-link flow, documented here for visibility.
 */
export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (confirmRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const url = new URL(req.url);
  // Landing-path builder: success lands on the stored signup locale
  // (resolved to a routable home — no middleware re-detection hop, toast
  // in the user's language); every failure leg lands on the bare home.
  // resolveLocaleHome whitelists against the supported set, so even a
  // hand-edited account locale can never become a redirector.
  const homeRedirect = (locale: unknown, param: 'ok' | 'error'): Response => {
    const home = resolveLocaleHome(locale);
    return NextResponse.redirect(
      `${url.origin}${home}?confirmed=${param}`,
      302,
    );
  };

  const rawToken = url.searchParams.get('token');
  // Chat linkifiers (Steam's included) glue trailing punctuation into the
  // clickable link — a token arriving as "<64hex>." must still consume.
  // Safe to strip: a valid token is exactly 64 hex chars, so trailing
  // punctuation can never belong to one; only an exact valid prefix
  // survives this, which is precisely the mangled-link case.
  const token =
    rawToken === null ? null : rawToken.replace(/[.,;:!?)\]}'"]+$/, '');
  // Shape-gate before hashing anything: 64 hex chars, the only form our
  // issuer ever produces. Anything else is a probe, answered identically.
  if (token === null || token === '' || !/^[0-9a-f]{64}$/.test(token)) {
    return homeRedirect(null, 'error');
  }

  try {
    const steamId = await consumeConfirmToken(hashConfirmToken(token));
    if (steamId === null) {
      return homeRedirect(null, 'error');
    }
    // Save session AFTER token consumption. If this fails, the token is
    // already consumed (account confirmed) — we still redirect to 'ok' so
    // the user isn't stuck with a dead link, but log the session failure
    // explicitly for debugging.
    try {
      await saveWatchSession(cookies(), steamId);
    } catch (sessionError) {
      logRouteError('watchConfirm:session', sanitizeError(sessionError), {
        steamId,
      });
    }
    // Locale is display-only (which home translation the toast renders
    // in): a transient read failure here must never convert an already
    // consumed token + sealed session into an 'error' landing that tells
    // a confirmed, logged-in user their link was invalid.
    //
    // Session scope note: the cookie sealed here is the SAME general-site
    // iron-session used by SiteNav, the layout root, and all /api/watch/*
    // routes. It carries only `{ steamId, expiresAt }` (30-day TTL) and
    // is not "watch-only": a forwarded confirmation link effectively logs
    // the recipient in as the verified SteamID across the whole site.
    let locale: string | null = null;
    try {
      locale = (await getAccount(steamId))?.locale ?? null;
    } catch (accountError) {
      logRouteError('watchConfirm:locale', sanitizeError(accountError), {
        steamId,
      });
    }
    return homeRedirect(locale, 'ok');
  } catch (error) {
    logRouteError('watchConfirm', sanitizeError(error));
    return homeRedirect(null, 'error');
  }
}
