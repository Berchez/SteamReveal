import type { MetadataRoute } from 'next';

import {
  AI_OPT_OUT_TOKENS,
  AI_SEARCH_AND_USER_AGENTS,
  AI_TRAINING_CRAWLERS,
} from '@/lib/crawlers';
import robots from './robots';

// Intentional change-detector: the blocked set is a product decision, so
// adding or removing a token must touch this file on purpose. The
// grouping itself lives in src/lib/crawlers.ts (single source of truth).
const EXPECTED_BLOCKED = [
  'Meta-ExternalAgent',
  'Meta-ExternalFetcher',
  'FacebookBot',
  'GPTBot',
  'ChatGPT-User',
  'OAI-SearchBot',
  'ClaudeBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Claude-User',
  'Claude-SearchBot',
  'MistralAI-User',
  'Google-Extended',
  'Applebot-Extended',
  'CCBot',
  'Bytespider',
];

// Agents that must NEVER be disallowed: killing these breaks link
// previews (facebookexternalhit et al.) or web-search indexing, which is
// the opposite of this file's intent.
const MUST_STAY_ALLOWED = [
  'facebookexternalhit',
  'Facebot',
  'Googlebot',
  'Bingbot',
  'Applebot',
  'DuckDuckBot',
  'Slackbot',
  'Twitterbot',
  'Meta-WebIndexer',
];

// Public paths every allowed crawler (preview fetchers, Googlebot) must
// reach: home, locale homes, player pages, sitemap, and the framework
// asset/image pipelines Googlebot needs to render (/_next/* has been
// Next's stable prefix for a decade — asserting ALLOWED here is robust:
// it only fails if someone disallows them, which is exactly the
// regression this guards).
const MUST_STAY_CRAWLABLE = [
  '/',
  '/en',
  '/en/player/76561198000000000',
  '/sitemap.xml',
  '/_next/static/chunks/app/page.js',
  '/_next/image?url=%2Favatar.png&w=96&q=75',
];

type RobotsRule = {
  userAgent?: string | string[];
  allow?: string | string[];
  disallow?: string | string[];
};

const asRuleList = (rules: MetadataRoute.Robots['rules']): RobotsRule[] => {
  if (rules === undefined) return [];
  return (Array.isArray(rules) ? rules : [rules]) as RobotsRule[];
};

const asList = (value: string | string[] | undefined): string[] => {
  if (value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((entry) =>
    entry.toLowerCase(),
  );
};

/** True when any rule matching `agent` (or `*`) disallows `path`. */
const isPathDisallowed = (
  list: RobotsRule[],
  agent: string,
  path: string,
): boolean => {
  const loweredAgent = agent.toLowerCase();
  return list.some((rule) => {
    const agents = asList(rule.userAgent);
    if (!agents.includes('*') && !agents.includes(loweredAgent)) {
      return false;
    }
    return asList(rule.disallow).some(
      (entry) => entry === '/' || path.startsWith(entry),
    );
  });
};

const EXPECTED_AI_AGENTS_SORTED = EXPECTED_BLOCKED.map((entry) =>
  entry.toLowerCase(),
).sort();

describe('robots.txt', () => {
  it('disallows / for exactly the AI-crawler set (no more, no less)', () => {
    const list = asRuleList(robots().rules);
    const blocked = list.flatMap((rule) =>
      asList(rule.disallow).includes('/') ? asList(rule.userAgent) : [],
    );

    expect([...blocked].sort()).toEqual(EXPECTED_AI_AGENTS_SORTED);
    // Deliberate double assertion: the first pins the product decision
    // (this file), the second pins that robots.ts serves the lib set
    // verbatim instead of freelancing extra tokens.
    expect([...blocked].sort()).toEqual(
      [
        ...AI_TRAINING_CRAWLERS,
        ...AI_SEARCH_AND_USER_AGENTS,
        ...AI_OPT_OUT_TOKENS,
      ]
        .map((entry) => entry.toLowerCase())
        .sort(),
    );
  });

  it('keeps the public crawl policy (allow /, /private/ + /api/ closed)', () => {
    const list = asRuleList(robots().rules);
    const wildcard = list.find((rule) => rule.userAgent === '*');

    expect(wildcard).toBeDefined();
    expect(wildcard?.allow).toBe('/');
    expect(wildcard?.disallow).toEqual(['/private/', '/api/']);
  });

  it('never disallows preview or search-index agents (case-insensitive)', () => {
    const list = asRuleList(robots().rules);
    const disallowed = list.flatMap((rule) =>
      asList(rule.disallow).length > 0 ? asList(rule.userAgent) : [],
    );

    for (const agent of MUST_STAY_ALLOWED) {
      expect(disallowed).not.toContain(agent.toLowerCase());
    }
  });

  it('keeps public paths crawlable for allowed agents (unfurl + render)', () => {
    // Guards the P1 that motivated it: closing /api/ must never take a
    // public page with it. facebookexternalhit reads only HTML head;
    // Googlebot renders the SSR core — both need these paths reachable.
    const list = asRuleList(robots().rules);

    for (const path of MUST_STAY_CRAWLABLE) {
      expect(isPathDisallowed(list, '*', path)).toBe(false);
      expect(isPathDisallowed(list, 'facebookexternalhit', path)).toBe(false);
      expect(isPathDisallowed(list, 'Googlebot', path)).toBe(false);
    }
  });

  it('has no duplicate or wildcard tokens in the blocked set', () => {
    const list = asRuleList(robots().rules);
    const blocked = list.flatMap((rule) =>
      asList(rule.disallow).includes('/') ? asList(rule.userAgent) : [],
    );

    expect(new Set(blocked).size).toBe(blocked.length);
    expect(blocked).not.toContain('*');
  });

  it('keeps the sitemap pointer on the canonical origin', () => {
    // Literal, not SITE_BASE_URL: a drifted origin (www, trailing slash,
    // preview env) must fail loudly here instead of passing against
    // itself.
    expect(robots().sitemap).toBe(
      'https://steam-reveal.vercel.app/sitemap.xml',
    );
  });
});
