/**
 * Crawler policy lists — single source of truth for robots.txt (imported
 * by src/app/robots.ts; the test pins the exact set so additions and
 * removals are always deliberate).
 *
 * Criterion: crawlers whose fetched data feeds AI products — training
 * weights AND live answers (RAG / search citations). Classic web search
 * (Googlebot, Bingbot, Applebot, DuckDuckBot) and link-preview fetchers
 * (facebookexternalhit, Slackbot, …) stay allowed under `*` on purpose:
 * the sitemap exists for search, and previews break without their
 * fetchers. Blocking the search/answer half below costs AI
 * discoverability (no ChatGPT/Perplexity citations) — accepted trade-off,
 * recorded here so it is never removed by accident.
 *
 * Deliberately absent:
 * - `cohere-ai`: vendor denies any current crawling/training use (their
 *   example token is `Coherebot`); nothing to block.
 * - `PetalBot`, `amazonbot`, `Diffbot`: search/scraping products outside
 *   this criterion. Revisit quarterly — vendor docs are the source of
 *   truth, names change.
 */

/** Bulk crawling believed to feed model training (weights). */
export const AI_TRAINING_CRAWLERS = [
  // Meta training family (current + legacy belt-and-braces).
  'Meta-ExternalAgent',
  'FacebookBot',
  // OpenAI training.
  'GPTBot',
  // Anthropic training (current + legacy, still seen).
  'ClaudeBot',
  'anthropic-ai',
  // Third-party training sets.
  'CCBot',
  'Bytespider',
] as const;

/**
 * AI search/answer retrieval + on-demand user fetches. Vendors state
 * these are NOT training crawlers — they are blocked here anyway because
 * they serve AI products with site data (see criterion above).
 */
export const AI_SEARCH_AND_USER_AGENTS = [
  // OpenAI retrieval + on-demand fetches.
  'OAI-SearchBot',
  'ChatGPT-User',
  // Perplexity retrieval + on-demand fetches.
  'PerplexityBot',
  'Perplexity-User',
  // Anthropic retrieval + on-demand fetches.
  'Claude-User',
  'Claude-SearchBot',
  // Meta assistant fetching (Meta warns it may bypass robots.txt —
  // listing is best-effort, real enforcement is a Firewall rule).
  'Meta-ExternalFetcher',
  // Mistral on-demand fetches.
  'MistralAI-User',
] as const;

/**
 * Standalone training opt-outs. These tokens never issue requests —
 * vendors check them against logs from their main crawlers — so they
 * cost nothing and can never break previews or Search.
 */
export const AI_OPT_OUT_TOKENS = [
  'Google-Extended',
  'Applebot-Extended',
] as const;
