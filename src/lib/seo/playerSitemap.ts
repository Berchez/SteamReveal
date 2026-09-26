/**
 * Programmatic player-sitemap builders (P0 SEO) — pure functions over the
 * PopularProfile aggregates from the analytics DAL. Kept side-effect-free
 * (no DB, no env) so the sitemap route stays thin and every rule below is
 * unit-testable:
 *
 * - One <url> per profile with loc = the `en` player page plus hreflang
 *   alternates for all 8 locales (matches the page's own canonical +
 *   alternates contract in [locale]/player/[steamId]/page.tsx).
 * - lastModified = latest recorded search (real freshness — never
 *   `new Date()` per hit, which would tell Google everything changed).
 * - Only well-formed rows become entries (the DAL already drops malformed
 *   steam_ids; the builder additionally requires a non-empty timestamp).
 * - No cheater data travels by construction: entries carry URL +
 *   lastModified only (the page title resolves live from Steam).
 */

import type { MetadataRoute } from 'next';

import { SUPPORTED_LOCALES } from '../../locales';
import type { PopularProfile } from '../analytics/types';

/** Canonical site origin (same literal as layout metadataBase). */
export const SITE_BASE_URL = 'https://steam-reveal.vercel.app';

/** Profiles graduate into the sitemap at this demand threshold. */
export const SITEMAP_MIN_SEARCHES = 3;

/**
 * ...spread over this many distinct UTC days (anti-abuse: back-to-back
 * lookups alone never graduate a stranger into the public sitemap).
 */
export const SITEMAP_MIN_DAYS = 2;

/**
 * Total player URLs served (Google allows 50k/file — headroom kept).
 * Product cap: must stay <= the DAL safety ceiling
 * POPULAR_PROFILES_MAX_LIMIT (lib/analytics/db.ts), which silently clamps
 * anything above — raising this past that ceiling changes nothing.
 */
export const SITEMAP_MAX_URLS = 10000;

const trimOrigin = (baseUrl: string): string => baseUrl.replace(/\/+$/, '');

const playerPath = (locale: string, steamId: string): string =>
  `/${locale}/player/${steamId}`;

/**
 * Static entries (home + 8 locale homes). lastModified is caller-owned so
 * the route can pass a stable date (per-hit `new Date()` would mark every
 * URL modified on every crawl).
 */
export const buildLocaleHomeEntries = (
  baseUrl: string = SITE_BASE_URL,
  lastModified: Date = new Date(),
): MetadataRoute.Sitemap => {
  const origin = trimOrigin(baseUrl);
  return [
    { url: `${origin}/`, lastModified, priority: 1 },
    ...SUPPORTED_LOCALES.map((locale) => ({
      url: `${origin}/${locale}`,
      lastModified,
    })),
  ];
};

/**
 * Player entries for one shard: loc = en page, hreflang alternates for
 * every locale, lastModified = latest recorded search. Rows without a
 * usable timestamp fall out (a sitemap lastmod must be real).
 */
export const buildPlayerSitemapEntries = (
  profiles: PopularProfile[],
  baseUrl: string = SITE_BASE_URL,
): MetadataRoute.Sitemap => {
  const origin = trimOrigin(baseUrl);
  const alternates = (steamId: string): Record<string, string> => {
    const languages: Record<string, string> = {};
    // eslint-disable-next-line no-restricted-syntax
    for (const locale of SUPPORTED_LOCALES) {
      languages[locale] = `${origin}${playerPath(locale, steamId)}`;
    }
    return languages;
  };
  const entries: MetadataRoute.Sitemap = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const profile of profiles) {
    const usable =
      typeof profile?.steamId === 'string' &&
      profile.steamId.length > 0 &&
      typeof profile?.lastSearchedAt === 'string' &&
      profile.lastSearchedAt.length > 0;
    if (usable) {
      entries.push({
        url: `${origin}${playerPath('en', profile.steamId)}`,
        lastModified: profile.lastSearchedAt,
        alternates: { languages: alternates(profile.steamId) },
      });
    }
  }
  return entries;
};
