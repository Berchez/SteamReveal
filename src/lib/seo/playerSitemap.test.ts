/**
 * Programmatic player-sitemap unit tests (P0 SEO): pure-builder rules
 * (success + edge + error cases) plus the indexability guardrail — the
 * Metadata.Player title/description rendered into <title>/<meta> on every
 * /player/:id page must stay free of cheater/ban verdicts in all 8
 * locales (a model probability is not proof; an indexed "X is a cheater"
 * page is a defamation risk).
 */

import fs from 'fs';
import path from 'path';

import { SUPPORTED_LOCALES } from '../../locales';
import type { PopularProfile } from '../analytics/types';
import {
  buildLocaleHomeEntries,
  buildPlayerSitemapEntries,
  SITE_BASE_URL,
  SITEMAP_MAX_URLS,
  SITEMAP_MIN_DAYS,
  SITEMAP_MIN_SEARCHES,
} from './playerSitemap';

const profile = (
  steamId: string,
  lastSearchedAt = '2026-09-20T00:00:00.000Z',
  searchCount = 5,
): PopularProfile => ({
  steamId,
  nickname: 'SomePlayer',
  lastSearchedAt,
  searchCount,
});

describe('buildLocaleHomeEntries', () => {
  it('serves home plus all 8 locale homes', () => {
    const entries = buildLocaleHomeEntries();
    const urls = entries.map((entry) => entry.url);
    expect(urls).toContain(`${SITE_BASE_URL}/`);
    for (const locale of SUPPORTED_LOCALES) {
      expect(urls).toContain(`${SITE_BASE_URL}/${locale}`);
    }
    expect(entries).toHaveLength(1 + SUPPORTED_LOCALES.length);
  });

  it('keeps a stable lastModified (never per-hit new Date in the route)', () => {
    const fixed = new Date('2026-09-26T00:00:00.000Z');
    const entries = buildLocaleHomeEntries(SITE_BASE_URL, fixed);
    for (const entry of entries) {
      expect(entry.lastModified).toBe(fixed);
    }
  });
});

describe('buildPlayerSitemapEntries', () => {
  it('emits one en URL with hreflang alternates for every locale', () => {
    const entries = buildPlayerSitemapEntries([profile('76561198000000001')]);
    expect(entries).toHaveLength(1);
    expect(entries[0].url).toBe(
      `${SITE_BASE_URL}/en/player/76561198000000001`,
    );
    const languages = (
      entries[0] as { alternates?: { languages?: Record<string, string> } }
    ).alternates?.languages;
    expect(Object.keys(languages ?? {}).sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
    expect(languages?.pt).toBe(
      `${SITE_BASE_URL}/pt/player/76561198000000001`,
    );
  });

  it('passes the latest search through as lastModified (real freshness)', () => {
    const entries = buildPlayerSitemapEntries([
      profile('76561198000000001', '2026-09-25T12:00:00.000Z'),
    ]);
    expect(entries[0].lastModified).toBe('2026-09-25T12:00:00.000Z');
  });

  it('drops rows without a usable id or timestamp (never a dead URL)', () => {
    const entries = buildPlayerSitemapEntries([
      profile('76561198000000001'),
      { ...profile('76561198000000002'), steamId: '' },
      { ...profile('76561198000000003'), lastSearchedAt: '' },
    ]);
    expect(entries.map((entry) => entry.url)).toEqual([
      `${SITE_BASE_URL}/en/player/76561198000000001`,
    ]);
  });

  it('returns no entries for an empty profile list', () => {
    expect(buildPlayerSitemapEntries([])).toEqual([]);
  });

  it('exposes the demand gate and the crawl-budget cap', () => {
    expect(SITEMAP_MIN_SEARCHES).toBe(3);
    expect(SITEMAP_MIN_DAYS).toBe(2);
    expect(SITEMAP_MAX_URLS).toBe(10000);
  });
});

describe('Metadata.Player indexability guardrail', () => {
  const loadPlayerMeta = (
    locale: string,
  ): Record<string, string> => {
    const raw = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', 'messages', `${locale}.json`),
      'utf8',
    );
    const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
    return (JSON.parse(withoutBom) as { Metadata: { Player: Record<string, string> } })
      .Metadata.Player;
  };

  it.each([...SUPPORTED_LOCALES])(
    'keeps %s indexed title/description free of cheater/ban verdicts',
    (locale) => {
      const meta = loadPlayerMeta(locale);
      for (const key of ['title', 'description'] as const) {
        expect(typeof meta[key]).toBe('string');
        expect(meta[key].length).toBeGreaterThan(0);
        // A cheater-probability score is not proof: an indexed verdict
        // ("X is a cheater/banned") is a defamation risk. Verdicts stay
        // behind the report click; indexed metadata names public data only.
        expect(meta[key]).not.toMatch(/cheat|banned/i);
      }
    },
  );

  it.each([...SUPPORTED_LOCALES])(
    'keeps the {nickname} placeholder in %s indexed title/description',
    (locale) => {
      const meta = loadPlayerMeta(locale);
      // The player page interpolates t('title'/'description', { nickname }):
      // a translation that drops the placeholder silently renders every
      // indexed page with a missing name.
      expect(meta.title).toContain('{nickname}');
      expect(meta.description).toContain('{nickname}');
    },
  );
});
