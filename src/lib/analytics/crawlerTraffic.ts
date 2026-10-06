/**
 * Crawler User-Agent denylist for the analytics write path — a leaf module
 * (its only import is the dependency-free token lists in ../crawlers, so it
 * stays out of client bundles; imported by API routes only).
 *
 * Why this exists: shared player URLs get fetched by link-preview bots
 * (Facebook/Twitter/Slack/Discord crawlers) and search-engine spiders.
 * Those clients run no page JS, but headless fallbacks, pre-render
 * services and direct API replays sometimes DO fire the analytics beacon
 * — and every such hit lands in Turso as a "search" no human ever ran,
 * polluting the owner dashboard (totals, top-N lists, cheater rows).
 *
 * Design rules (do not loosen without thinking):
 * - Denylist, never allowlist: unknown, empty and privacy-stripped UAs
 *   (curl, node/smoke scripts, stripped browsers) MUST keep recording.
 *   The beacon is analytics-only — a false negative pollutes one row,
 *   but a false positive is silent data loss the owner can never audit.
 * - Tokens only crawlers send: no real browser UA contains any of these.
 *   Each entry was checked against its real-world colliding UA before
 *   being added (notably: bare 'sogou' matches SogouMobileBrowser, bare
 *   'pinterest'/'viber' risk in-app WebViews, bare 'whatsapp' is kept
 *   slash-suffixed ('whatsapp/') since only the fetcher carries it, and
 *   bare 'bot'/'preview'/'headless' collide with Safari Technology
 *   Preview and dev automation — all deliberately absent or narrowed;
 *   the spider-specific forms are used instead).
 * - Mirrors the robots.txt AI policy (src/lib/crawlers.ts): every AI
 *   training/search token blocked there is blocked here too, so an agent
 *   that fetches AND fires the beacon is skipped at both layers. The
 *   reverse is not true — automation-only tokens (Slack-ImgProxy,
 *   'crawler', 'scraper') live here alone, since they never train models
 *   but do replay beacons.
 * - A bot spoofing a normal Chrome UA is indistinguishable at this layer
 *   (Vercel exposes no TLS/JA4 or ASN signals to the function) — this
 *   stops self-identifying crawlers, not a determined impersonator. That
 *   residual is accepted and documented, not a bug to "fix" here.
 */

import {
  AI_OPT_OUT_TOKENS,
  AI_SEARCH_AND_USER_AGENTS,
  AI_TRAINING_CRAWLERS,
} from '../crawlers';

const CRAWLER_TOKENS = [
  // Meta link preview + ads crawlers (facebookexternalhit is the classic
  // shared-link fetcher; Facebot is search; the Meta-External* family is
  // the newer documented set).
  'facebookexternalhit',
  'facebot',
  'facebookcatalog',
  'meta-externalagent',
  'meta-externalads',
  // Other link-preview fetchers (chat apps unfurling shared player URLs).
  'twitterbot',
  'linkedinbot',
  'slackbot',
  'slack-imgproxy',
  'discordbot',
  'telegrambot',
  'whatsapp/',
  'skypeuripreview',
  'vkshare',
  // NOTE: no 'viber' — its in-app WebView UAs risk colliding, and a missed
  // Viber unfurl is a polluting row while a false positive is silent loss.
  // Same asymmetry as everywhere in this file: when in doubt, keep recording.
  // Search-engine spiders.
  'googlebot',
  'mediapartners-google',
  'adsbot-google',
  'apicallback-google',
  'bingbot',
  'bingpreview',
  'slurp',
  'duckduckbot',
  'baiduspider',
  'yandexbot',
  // Sogou spider forms only — bare 'sogou' also matches the real
  // SogouMobileBrowser and would silently drop human searches.
  'sogou web spider',
  'sogou orion spider',
  'exabot',
  'applebot',
  // AI search crawlers (all self-identifying; no browser contains these).
  'gptbot',
  'oai-searchbot',
  'claudebot',
  'perplexitybot',
  'ahrefsbot',
  'semrushbot',
  'bytespider',
  // Misc unfurlers/scrapers ('pinterestbot' only — bare 'pinterest' risks
  // in-app WebViews; 'viber' dropped for the same reason).
  'pinterestbot',
  'embedly',
  'quora link preview',
  'outbrain',
  // Generic automation markers no interactive browser ever sends.
  'crawler',
  'scraper',
  // AI policy tokens from src/lib/crawlers.ts (robots.txt set): an agent
  // that both crawls and fires the beacon must be skipped at both layers.
  // Lowercased + deduped below (several overlap the entries above).
  ...AI_TRAINING_CRAWLERS,
  ...AI_SEARCH_AND_USER_AGENTS,
  ...AI_OPT_OUT_TOKENS,
].map((token) => token.toLowerCase())
  .filter((token, index, all) => all.indexOf(token) === index);

// Named (not default) export on purpose: the route imports the predicate
// by name next to its siblings.
// eslint-disable-next-line import/prefer-default-export
export const isCrawlerUserAgent = (userAgent: unknown): boolean => {
  if (typeof userAgent !== 'string' || userAgent.length === 0) return false;
  const lowered = userAgent.toLowerCase();
  return CRAWLER_TOKENS.some((token) => lowered.includes(token));
};
