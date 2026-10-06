import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import withTimeout from '@/lib/withTimeout';
import {
  DASHBOARD_HISTORY_LIMIT,
  DASHBOARD_HISTORY_LIMIT_MAX,
  getDashboardHistory,
  getDashboardStats,
  getLoginFunnelStats,
  getWatchDashboardData,
  readModalStatsIsolated,
} from '@/lib/analytics/db';
import { renderDashboard } from '@/lib/analytics/dashboardRender';
import { STATS_READ_TIMEOUT_MS } from './dashboardStatsConfig';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const dashboardRateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

/**
 * Budget for the additive halves of the dashboard (Watch + login funnel +
 * modals). allSettled alone only covers *errors* — without this, a
 * slow/hung query in either half (watch_events grows one row per bot
 * delivery, no retention) would hold the whole page, including the primary
 * searches section, until the platform 504s. Promise.race doesn't cancel
 * the driver query, it just frees the response (accepted limitation, same
 * as every other withTimeout call site).
 *
 * Module-scoped (NOT exported: Next.js route files may only export
 * route-related names — an extra export breaks the generated route types).
 */
const ADDITIVE_READ_TIMEOUT_MS = 4_000;

// Search-stats budget + rationale live in ./dashboardStatsConfig (imported
// below); see that module — not repeated here.

/**
 * Parses ?limit= into a clamped history window. Garbage in → default out
 * (never 400: a bookmarked dashboard link must keep rendering); the DAL
 * clamps again defensively, so this is purely the route honoring intent.
 */
const parseHistoryLimit = (params: URLSearchParams): number => {
  // Number(null) === 0 and Number('') === 0 — an absent or empty ?limit=
  // must mean "default", never "1 row". Non-finite strings (NaN,
  // Infinity) fall back the same way; only a real number clamps (ceiling
  // shared with the DAL so the two can never drift).
  const param = params.get('limit');
  if (param === null || param.trim() === '') return DASHBOARD_HISTORY_LIMIT;
  const raw = Number(param);
  if (!Number.isFinite(raw)) return DASHBOARD_HISTORY_LIMIT;
  return Math.max(1, Math.min(DASHBOARD_HISTORY_LIMIT_MAX, Math.floor(raw)));
};

/**
 * Serves the analytics dashboard as live HTML, rebuilt on every request
 * from the current Turso data (capped history via getDashboardHistory,
 * default DASHBOARD_HISTORY_LIMIT rows, widenable via ?limit= up to
 * DASHBOARD_HISTORY_LIMIT_MAX + the additive Watch section via getWatchDashboardData
 * + the additive login-funnel section via getLoginFunnelStats + the
 * additive promo-modal sections via readModalStatsIsolated + the
 * search-stats section via getDashboardStats, which carries its own larger
 * timeout because it feeds most panels — see STATS_READ_TIMEOUT_MS).
 *
 * The Watch, funnel, modal AND search-stats halves are fail-open on
 * error AND latency: a throw or a timeout degrades that half to null
 * instead of 500ing. (Latency fail-open saves the status code, not the
 * TTFB — allSettled still waits out the slowest budget. See the
 * STATS_READ_TIMEOUT_MS note above.)
 *
 * This replaces the old local analytics.html file, which only lived on the
 * machine running the proxy. The markup/styling/JS shell is
 * src/lib/analytics/dashboardTemplate.ts — the content it renders is
 * exactly what used to be written to that file.
 *
 * Gates access behind ANALYTICS_DASHBOARD_PASSWORD (its OWN env var,
 * deliberately separate from the write routes' ANALYTICS_SKIP_PASSWORD so the
 * dashboard-read secret and the analytics-write skip secret can never be
 * leaked by a shared credential) when that env var is set. The key is
 * accepted EITHER as ?key= (legacy/bookmarkable) OR as an x-analytics-key
 * request header (keeps the secret out of URLs/logs — the header form is
 * what the smoke scripts use). Both go through a timing-safe comparison, and
 * the comparison is rate-limited per IP BEFORE it runs, so a wrong-key guess
 * can't be hammered.
 *
 * Without the env var it stays open in development only, matching the
 * "best-effort analytics" philosophy.
 *
 * Path: src/app/api/analytics/dashboard/route.ts
 */

export const revalidate = 0;

// The stats half may run up to STATS_READ_TIMEOUT_MS (25s); the function
// ceiling must outlive it or the platform 504s the whole page before the
// fail-open can degrade stats to null. 60s is within every plan's ceiling
// (limits: https://vercel.com/docs/functions/limitations) and pins this
// route well below the platform defaults, so one slow Turso window can't
// burn minutes of compute per load. Ignored outside Vercel (plain Node
// has no function ceiling). No vercel.json functions override exists for
// this path — if one is ever added, it takes precedence over this literal
// (Vercel precedence order).
export const maxDuration = 60;

// Remote Turso URLs (libsql://, https://) use @libsql/client's pure-JS hrana
// transport — no native binary is loaded on this path. It still assumes the
// full Node server (WebSocket/fetch, real I/O), so keep `runtime = 'nodejs'`.
export const runtime = 'nodejs';

export async function GET(req: Request) {
  const { ANALYTICS_DASHBOARD_PASSWORD } = process.env;

  // Fail-closed REGARDLESS of host and NODE_ENV: an OSINT dashboard whose env
  // var was left unset must NOT open up to the whole internet (steamIds,
  // nicknames, friend networks and location guesses of real searched
  // profiles). Keying on NODE_ENV (not Vercel-specific VERCEL/VERCEL_ENV)
  // covers self-hosted, Docker, Railway, Fly.io — and, unlike the old
  // `=== 'production'` test, also a misconfigured/staging server where
  // NODE_ENV is unset (failing open was the silent PII leak). Only explicit
  // 'development' keeps the passwordless behavior for local `next dev`.
  if (!ANALYTICS_DASHBOARD_PASSWORD && process.env.NODE_ENV !== 'development') {
    return new NextResponse(
      'Analytics dashboard is disabled: ANALYTICS_DASHBOARD_PASSWORD is not configured on this deployment.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  if (ANALYTICS_DASHBOARD_PASSWORD) {
    // Rate-limit the AUTH check itself: an attacker probing the key with
    // unlimited attempts (no auth = 401, no DB cost — but the timing-safe
    // compare still needs a ceiling) would otherwise brute-force it over a
    // slow crawl. Same per-IP, per-warm-instance semantics as the write routes.
    if (dashboardRateLimiter.isRateLimited(getRequestIp(req))) {
      return errorResponse('Too many requests.', 429, 'RATE_LIMITED');
    }

    // Header-first: the smoke scripts and any scripted consumer send
    // x-analytics-key so the secret never appears in a URL (it would land in
    // access logs). ?key= is kept for humans bookmarking the dashboard page.
    const key =
      req.headers.get('x-analytics-key') ??
      new URL(req.url).searchParams.get('key') ??
      '';
    if (!timingSafeEqualStrings(key, ANALYTICS_DASHBOARD_PASSWORD)) {
      return new NextResponse('Unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }
  }

  if (!process.env.DATABASE_URL) {
    // Match the write routes' "best-effort" spirit: no Turso configured means
    // there is nothing to render, and a clear 503 beats a generic 500.
    return new NextResponse(
      'Analytics dashboard is unavailable: DATABASE_URL is not configured on this deployment.',
      {
        status: 503,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      },
    );
  }

  try {
    // Reads run together (one Turso round trip each, no shared snapshot
    // needed across the domains). The history half stays unbounded-time
    // (it IS the primary content) but bounded-rows: the newest N records
    // (default DASHBOARD_HISTORY_LIMIT, widenable via ?limit=) with a UI
    // note saying so. The Watch, funnel and modal halves are fail-open
    // under ADDITIVE_READ_TIMEOUT_MS; the heavier search-stats half gets
    // STATS_READ_TIMEOUT_MS instead. Any half that throws OR exceeds its
    // budget still renders with an "unavailable" section (null) instead of
    // 500ing or stalling the whole page.
    const historyLimit = parseHistoryLimit(new URL(req.url).searchParams);
    const [entriesResult, watchResult, funnelResult, modalsResult, statsResult] =
      await Promise.allSettled([
        getDashboardHistory(historyLimit),
        withTimeout(
          getWatchDashboardData(),
          'watch dashboard',
          ADDITIVE_READ_TIMEOUT_MS,
        ),
        withTimeout(
          getLoginFunnelStats(),
          'login funnel dashboard',
          ADDITIVE_READ_TIMEOUT_MS,
        ),
        withTimeout(
          readModalStatsIsolated(),
          'modal stats dashboard',
          ADDITIVE_READ_TIMEOUT_MS,
        ),
        withTimeout(
          getDashboardStats(),
          'search stats dashboard',
          STATS_READ_TIMEOUT_MS,
        ),
      ]);
    // Log each additive-half failure FIRST so a simultaneous entries failure
    // (which throws below) cannot swallow it — in a real incident several
    // halves failing at once is exactly when each reason matters. Separate
    // tags so a missing 015 migration (funnel-only) doesn't read as a
    // searches outage in the logs.
    if (watchResult.status === 'rejected') {
      logRouteError(
        'analytics/dashboard:watch',
        sanitizeError(watchResult.reason),
      );
    }
    if (funnelResult.status === 'rejected') {
      logRouteError(
        'analytics/dashboard:loginFunnel',
        sanitizeError(funnelResult.reason),
      );
    }
    if (modalsResult.status === 'rejected') {
      logRouteError(
        'analytics/dashboard:modals',
        sanitizeError(modalsResult.reason),
      );
    }
    if (statsResult.status === 'rejected') {
      logRouteError(
        'analytics/dashboard:stats',
        sanitizeError(statsResult.reason),
      );
    }
    if (entriesResult.status === 'rejected') throw entriesResult.reason;
    const html = renderDashboard({
      entries: entriesResult.value,
      watch: watchResult.status === 'fulfilled' ? watchResult.value : null,
      funnel: funnelResult.status === 'fulfilled' ? funnelResult.value : null,
      modals: modalsResult.status === 'fulfilled' ? modalsResult.value : null,
      stats: statsResult.status === 'fulfilled' ? statsResult.value : null,
    });

    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
        // Owner-only analytics page carrying a bookmarkable ?key=: never
        // leak the URL (or the page itself to indexers) via outbound
        // navigation or crawling. Belt-and-braces alongside rel=noopener
        // on the rendered profile links.
        'referrer-policy': 'no-referrer',
        'x-robots-tag': 'noindex, nofollow',
      },
    });
  } catch (error) {
    logRouteError('analytics/dashboard', sanitizeError(error));
    return errorResponse(
      'Failed to render the analytics dashboard.',
      500,
      'INTERNAL_ERROR',
    );
  }
}