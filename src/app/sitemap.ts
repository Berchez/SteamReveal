import type { MetadataRoute } from 'next';

import {
  buildLocaleHomeEntries,
  buildPlayerSitemapEntries,
  SITE_BASE_URL,
  SITEMAP_MAX_URLS,
  SITEMAP_MIN_DAYS,
  SITEMAP_MIN_SEARCHES,
} from '@/lib/seo/playerSitemap';
import { listPopularProfiles } from '@/lib/analytics/db';
import logRouteError from '@/lib/logRouteError';
import withTimeout from '@/lib/withTimeout';

export const runtime = 'nodejs';

// One Turso read per day (not per crawl): sitemap fetches are cheap, but
// crawl-scale traffic must never fan out into the analytics DB on every
// hit. Single file by design (≤ SITEMAP_MAX_URLS entries, far below
// Google's 50k/file limit): Next 14.2 has no automatic sitemap index for
// generateSitemaps at the root, so sharding would orphan /sitemap.xml
// (verified in the installed source — the bare route 404s once
// generateSitemaps is exported). Revisit sharding past ~40k URLs.
export const revalidate = 86400;

// Slow-degraded Turso must not hang the route past the serverless budget:
// the race below fails open to the static homes exactly like a rejected
// read (a hang is the one failure mode try/catch alone cannot catch).
const SITEMAP_DB_TIMEOUT_MS = 10000;

/**
 * Static homes plus demand-ordered player pages (most-searched first,
 * real lastModified). A dead/slow DB degrades LOUDLY to the static homes
 * instead of failing the crawl: crawlers keep a valid sitemap (robots.ts
 * points at /sitemap.xml) and the player entries heal on the next
 * revalidation window.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticEntries = buildLocaleHomeEntries(SITE_BASE_URL, new Date());
  try {
    const rows = await withTimeout(
      listPopularProfiles(
        SITEMAP_MAX_URLS,
        0,
        SITEMAP_MIN_SEARCHES,
        SITEMAP_MIN_DAYS,
      ),
      'sitemap: popular profiles',
      SITEMAP_DB_TIMEOUT_MS,
    );
    return [
      ...staticEntries,
      ...buildPlayerSitemapEntries(rows, SITE_BASE_URL),
    ];
  } catch (error) {
    // Durable alert surface (not just Vercel function logs nobody watches):
    // logRouteError keeps the console line AND appends the sanitized stack
    // to the ops log — a sitemap silently stuck on static-only entries for
    // days must leave a trace where incidents get noticed.
    logRouteError('sitemap', error);
    return staticEntries;
  }
}
