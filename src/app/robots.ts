import type { MetadataRoute } from 'next';

import {
  AI_OPT_OUT_TOKENS,
  AI_SEARCH_AND_USER_AGENTS,
  AI_TRAINING_CRAWLERS,
} from '@/lib/crawlers';
import { SITE_BASE_URL } from '@/lib/seo/playerSitemap';

/**
 * AI-crawler opt-out. The blocked set lives in src/lib/crawlers.ts
 * (criterion: any crawler feeding AI products — training or live
 * answers — except classic search and link previews, which stay allowed
 * so SEO and unfurls keep working). Blocking the answer half costs AI
 * discoverability; that trade-off is recorded in the lib file.
 *
 * Honest limits: robots.txt is voluntary and never removes
 * already-collected data — if AI-crawler volume does not drop
 * post-deploy, enforce with a Vercel Firewall rule on the UA.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: [
          ...AI_TRAINING_CRAWLERS,
          ...AI_SEARCH_AND_USER_AGENTS,
          ...AI_OPT_OUT_TOKENS,
        ],
        disallow: '/',
      },
      {
        userAgent: '*',
        allow: '/',
        // /api/ serves only the app's own client (axios POSTs); no
        // crawler needs it for a complete index entry: player pages
        // SSR their indexable core (nickname/title/description + OG
        // image via generateMetadata, profile header via
        // initialProfile — pinned by e2e/player-loading-performance:
        // "HTML already contains the nickname before any client JS
        // runs", "no extra getUserInfo call" on direct loads). What a
        // bot render misses is enrichment (friends, GC names, cheater
        // badges), which also spares shared Steam/GamersClub/FACEIT
        // quota. If Search Console URL Inspection ever shows degraded
        // player indexing, reverting is this one line — validate
        // post-deploy per the PR checklist.
        disallow: ['/private/', '/api/'],
      },
    ],
    sitemap: `${SITE_BASE_URL}/sitemap.xml`,
  };
}
