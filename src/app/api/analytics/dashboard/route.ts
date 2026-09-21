import { NextResponse } from 'next/server';
import { errorResponse } from '@/lib/apiError';
import timingSafeEqualStrings from '@/lib/timingSafeEqualStrings';
import logRouteError from '@/lib/logRouteError';
import { sanitizeError } from '@/lib/sanitizeError';
import { createRateLimiter, getRequestIp } from '@/lib/rateLimit';
import withTimeout from '@/lib/withTimeout';
import {
  getSearchRecords,
  getWatchDashboardData,
} from '@/lib/analytics/db';
import { renderDashboard } from '@/lib/analytics/dashboardRender';

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 30;
const dashboardRateLimiter = createRateLimiter(RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX);

/**
 * Budget for the additive Watch half of the dashboard. allSettled alone only
 * covers *errors* — without this, a slow/hung watch query (watch_events
 * grows one row per bot delivery, no retention) would hold the whole page,
 * including the primary searches section, until the platform 504s.
 * Promise.race doesn't cancel the driver query, it just frees the response
 * (accepted limitation, same as every other withTimeout call site).
 *
 * Module-scoped (NOT exported: Next.js route files may only export
 * route-related names — an extra export breaks the generated route types).
 */
const WATCH_READ_TIMEOUT_MS = 4_000;

/**
 * Serves the analytics dashboard as live HTML, rebuilt on every request
 * from the current Turso data (searches via getSearchRecords + the additive
 * Watch section via getWatchDashboardData).
 *
 * The Watch half is fail-open (error AND latency): a throw or a timeout
 * degrades it to null instead of 500ing/delaying the primary searches page.
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
 * Without the env var it stays open in dev/test only, matching the
 * "best-effort analytics" philosophy.
 *
 * Path: src/app/api/analytics/dashboard/route.ts
 */

export const revalidate = 0;

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
    // needed across the two domains). The Watch half is fail-open: if it
    // throws OR exceeds WATCH_READ_TIMEOUT_MS, the dashboard still renders
    // searches with an "unavailable" Watch section (null) instead of 500ing
    // or stalling the whole page — the search history is the primary
    // content, Watch stats are additive.
    const [entriesResult, watchResult] = await Promise.allSettled([
      getSearchRecords(),
      withTimeout(
        getWatchDashboardData(),
        'watch dashboard',
        WATCH_READ_TIMEOUT_MS,
      ),
    ]);
    // Log the watch failure FIRST so a simultaneous entries failure (which
    // throws below) cannot swallow it — in a real incident both halves
    // failing at once is exactly when each reason matters. Separate tag so
    // a missing 010/011 migration (watch-only) doesn't read as a searches
    // outage in the logs.
    if (watchResult.status === 'rejected') {
      logRouteError(
        'analytics/dashboard:watch',
        sanitizeError(watchResult.reason),
      );
    }
    if (entriesResult.status === 'rejected') throw entriesResult.reason;
    const html = renderDashboard(
      entriesResult.value,
      watchResult.status === 'fulfilled' ? watchResult.value : null,
    );

    return new NextResponse(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store, max-age=0',
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