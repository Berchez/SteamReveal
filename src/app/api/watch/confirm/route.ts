import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { errorResponse } from '@/lib/apiError';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import { saveWatchSession } from '@/lib/watch/session';
import checkSameOrigin from '@/lib/watch/csrf';
import { resolveLocaleHome } from '@/lib/watch/loginNext';
import { resolveWatchLocale } from '@/lib/watch/notificationText';
import {
  activateWatch,
  consumeConfirmToken,
  enqueueEvent,
  getAccount,
  getAccountByConfirmTokenHash,
  hashConfirmToken,
} from '@/lib/analytics/db';
import { CONFIRM_PAGE_TEXT, type ConfirmPageText } from './confirmText';

export const runtime = 'nodejs';

export const revalidate = 0;

const RATE_LIMIT_WINDOW_MS = 60_000;
// GET serves the intermediate page (prefetchers, linkifiers, scanners):
// generous, page views only.
const RATE_LIMIT_GET_MAX = 30;
// POST consumes + activates + logs in: tighter, mirroring signup's
// authenticated-POST budget. A SEPARATE instance on purpose: a burst of
// third-party GETs (shared NAT/VPN egress) must never eat a legitimate
// click's POST budget. Token space is 256-bit (unguessable) in both
// cases, so these caps are only anti-noise, nothing more.
const RATE_LIMIT_POST_MAX = 10;
const confirmPageRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_GET_MAX,
);
const confirmPostRateLimiter = createRateLimiter(
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_POST_MAX,
);

/**
 * Confirms a bot-delivered confirmation link (`?token=<hex>`).
 *
 * Two legs, split precisely so prefetch can never mutate:
 * - GET renders an intermediate page and NOTHING ELSE: no consume, no
 *   activate, no session. Chat linkifiers, antivirus URL-scanning and
 *   browser prefetch all perform GETs before the real click — under the
 *   old single-GET design any of those SPENT the token (and, once
 *   activation gated on the click, would have ACTIVATED the watch), landing
 *   the user on an error page for a link they never touched. A prefetched
 *   page is now just a page.
 * - POST (explicit button click) consumes the token, activates the watch,
 *   enqueues the bot welcome, seals the session, and redirects. CSRF-gated
 *   like every authenticated POST (the form posts same-origin, so
 *   legitimate clicks always carry a matching Origin).
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
/**
 * Self-contained confirm page (no JS, no assets — a plain form POST, so it
 * works with scripts disabled and can never be "prefetched into" a state
 * change). Every interpolated value is either a fixed locale string from
 * the table above or the token itself, which is shape-gated to 64 hex
 * chars before this is ever called — neither can break out of markup.
 */
const renderConfirmPage = (
  text: ConfirmPageText,
  token: string,
  homePath: string,
  expired: boolean,
): string => {
  const inner = expired
    ? `<h1>${text.expiredTitle}</h1><p>${text.expiredBody}</p><a href="${homePath}">${text.homeLink}</a>`
    : `<h1>${text.title}</h1><p>${text.body}</p><form method="post" action="/api/watch/confirm?token=${token}"><button type="submit">${text.button}</button></form>`;
  return (
    `<!DOCTYPE html>` +
    `<html lang="${text.lang}">` +
    `<head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${text.title} — SteamReveal</title>` +
    `<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f0f14;color:#e5e5e5;font-family:system-ui,-apple-system,sans-serif;padding:24px;box-sizing:border-box}.card{max-width:480px;width:100%;background:#17171f;border:1px solid #2c2c38;border-radius:16px;padding:32px;text-align:center}h1{font-size:22px;margin:0 0 16px}p{color:#b9b9c7;line-height:1.6;margin:0 0 24px}button{height:48px;padding:0 24px;border:0;border-radius:999px;background:#7c3aed;color:#fff;font-weight:600;font-size:15px;cursor:pointer}a{color:#a78bfa}</style>` +
    `</head><body><main class="card">${inner}</main></body></html>`
  );
};

const confirmPageResponse = (html: string): Response =>
  new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Token-bearing page: never cache, never sniff.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });

/**
 * Shared token parsing for both legs: chat linkifiers (Steam's included)
 * glue trailing punctuation into the clickable link — a token arriving as
 * "<64hex>." must still work. Safe to strip: a valid token is exactly 64
 * hex chars, so trailing punctuation can never belong to one; only an
 * exact valid prefix survives this, which is precisely the mangled-link
 * case. Returns null for missing/malformed tokens (answered identically
 * on both legs).
 */
const parseConfirmToken = (req: Request): string | null => {
  const url = new URL(req.url);
  const rawToken = url.searchParams.get('token');
  // Shape-gate before hashing anything: 64 hex chars, the only form our
  // issuer ever produces. Anything else is a probe, answered identically.
  const token =
    rawToken === null ? null : rawToken.replace(/[.,;:!?)\]}'"]+$/, '');
  if (token === null || token === '' || !/^[0-9a-f]{64}$/.test(token)) {
    return null;
  }
  return token;
}

// Landing-path builder: success lands on the stored signup locale
// (resolved to a routable home — no middleware re-detection hop, toast
// in the user's language); every failure leg lands on the bare home.
// resolveLocaleHome whitelists against the supported set, so even a
// hand-edited account locale can never become a redirector.
const homeRedirect = (
  req: Request,
  locale: unknown,
  param: 'ok' | 'error',
): Response => {
  const home = resolveLocaleHome(locale);
  return NextResponse.redirect(
    `${new URL(req.url).origin}${home}?confirmed=${param}`,
    302,
  );
};

export async function GET(req: Request) {
  // App Router only routes GET here; kept as defense-in-depth (and so unit
  // tests can invoke GET() directly with other methods).
  if (req.method !== 'GET') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (confirmPageRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  const token = parseConfirmToken(req);
  if (token === null) {
    return homeRedirect(req, null, 'error');
  }

  try {
    // Non-consuming read: shows the page in the requester's language and
    // flags expired links WITHOUT spending the single-use token. Unknown
    // hashes render the same form page as valid ones (no oracle); only a
    // KNOWN-expired token gets the expired variant — a bounded,
    // rate-limited signal worth the UX (it points at the resend path
    // instead of a dead button). A read blip fails closed to the error
    // redirect: the POST would surface the real failure anyway.
    const account = await getAccountByConfirmTokenHash(
      hashConfirmToken(token),
    );
    const resolved = resolveWatchLocale(account?.locale ?? null);
    const text = CONFIRM_PAGE_TEXT[resolved];
    const expired =
      account !== null &&
      account.confirmExpiresAt !== null &&
      Date.parse(account.confirmExpiresAt) <= Date.now();
    // Corrupt expiry (unparseable) fails OPEN toward the form: the POST
    // validates for real, and blocking the page on a hand-edited row
    // would strand a user the POST could still serve.
    return confirmPageResponse(
      renderConfirmPage(
        text,
        token,
        resolveLocaleHome(resolved),
        expired,
      ),
    );
  } catch (error) {
    logRouteError('watchConfirm', sanitizeError(error));
    return homeRedirect(req, null, 'error');
  }
}

export async function POST(req: Request) {
  // Same defense-in-depth as GET (App Router routes POST here already).
  if (req.method !== 'POST') {
    return errorResponse('Method not allowed.', 405, 'METHOD_NOT_ALLOWED');
  }

  if (confirmPostRateLimiter.isRateLimited(getRequestIp(req))) {
    return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
  }

  // The form posts same-origin, so legitimate clicks always carry a
  // matching Origin — a missing/mismatched one is a cross-site forgery
  // riding the user's session (which this very endpoint seals), not a
  // browser quirk. Fail closed like signup/logout.
  if (!checkSameOrigin(req)) {
    return errorResponse('Forbidden.', 403, 'FORBIDDEN');
  }

  const token = parseConfirmToken(req);
  if (token === null) {
    return homeRedirect(req, null, 'error');
  }

  try {
    const steamId = await consumeConfirmToken(hashConfirmToken(token));
    if (steamId === null) {
      return homeRedirect(req, null, 'error');
    }
    // Click-to-activate: the consume above just proved the click, so this
    // is the ONE place a watch flips pending -> active for the accounts
    // flow (the bot reconcile only activates already-confirmed rows as a
    // backstop). A false return means the watch row vanished mid-click
    // (opt-out race) — the account IS confirmed and the session below
    // still seals, so land ok (never strand a confirmed user on a spent
    // token); the loud log below is the audit trail, and Start begins a
    // fresh request when there is no watch at all. A THROW is equally
    // non-fatal for the same reason AND self-heals: reconcile converges
    // pending+friend+confirmed on its next pass, so the activation still
    // lands without another click.
    let activated = false;
    try {
      activated = await activateWatch(steamId);
    } catch (activateError) {
      logRouteError(
        'watchConfirm:activate',
        sanitizeError(activateError),
        { steamId },
      );
    }
    if (!activated) {
      // Race condition: the confirm link was already consumed by a backstop
      // pass (reconcile) or the row was deleted. This is an expected race,
      // not an error — the user is confirmed and logged in. Log at info level
      // to avoid alert noise for this legitimate race. (Also covers a
      // grandfathered pre-gating row: active with a still-live token — the
      // click confirms + logs in, activation is trivially already done.)
      console.info(
        `[watchConfirm:activate] confirm consumed but this request did not activate steamId=${steamId} (row gone, backstop owns the flip, or grandfathered pre-gating row already active)`,
      );
      // Still fetch locale for the redirect (account is confirmed, so it exists)
      let locale: string | null = null;
      try {
        locale = (await getAccount(steamId))?.locale ?? null;
      } catch {
        locale = null;
      }
      // Still seal the session (account is confirmed), but don't enqueue welcome
      // (nothing to welcome; backstop-owned flips welcome via onActivated instead).
      try {
        await saveWatchSession(cookies(), steamId);
      } catch {
        // Session failure is non-fatal; landing page still works.
      }
      return homeRedirect(req, locale, 'ok');
    }

    // Welcome chat message via the outbox (the site cannot reach Steam
    // chat — the bot poller delivers). Emitted ONLY when this request
    // activated: backstop activations welcome via onActivated instead,
    // so emitting unconditionally would double-welcome exactly the
    // recovered users. Retried (max 3): a single DB blip must not silently
    // eat the only welcome — the row is already active, so no backstop
    // will ever re-emit it. A sustained outage still degrades loudly
    // below, and the confirmation + login stay durable regardless.
    let welcomed = false;
    for (let attempt = 0; attempt < 3 && !welcomed; attempt += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await enqueueEvent(steamId, 'welcome');
        welcomed = true;
      } catch (welcomeError) {
        if (attempt >= 2) {
          logRouteError(
            'watchConfirm:welcome',
            sanitizeError(welcomeError),
            { steamId },
          );
        }
      }
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
    return homeRedirect(req, locale, 'ok');
  } catch (error) {
    logRouteError('watchConfirm', sanitizeError(error));
    return homeRedirect(req, null, 'error');
  }
}