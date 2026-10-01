/**
 * Dashboard search-stats budget — single source of truth shared by the
 * dashboard route (`route.ts` in this directory) and its test.
 *
 * Unlike Watch/funnel/modals (small tables, additive panels), the stats
 * read scans the three big child tables (friends/games/locations grow
 * ~15/40/1 rows per search) and feeds most panels — primary content
 * wearing a fail-open coat: a throw or a timeout still renders the page
 * with explicit unavailable panels instead of 500ing, but the budget
 * gives the read room to finish as tables grow.
 *
 * 25s: production timed out at 8s once the child tables outgrew the old
 * headroom (~2.6s @ ~360k rows). The rewrite removes duplicate full scans
 * (one friends-totals statement instead of two subselects, one game_agg
 * CTE instead of two GROUP BYs — fewer passes by construction, not a
 * measured claim) and 019 adds the read-path indexes; the higher budget
 * covers the new p99 with margin while the 5min TTL memo keeps the heavy
 * batch rare.
 *
 * Honest TTFB note: Promise.allSettled waits for every half, so a slow
 * stats read delays the whole HTML (including the fast history table) up
 * to this budget — the fail-open saves the page from 500ing, not from
 * waiting. Splitting stats into a lazy client-fetched endpoint would fix
 * the TTFB properly; that is a follow-up, not this change.
 *
 * INVARIANT (enforced by route.test.ts "keeps the stats budget a safety
 * margin below maxDuration", which owns the margin value): keep this
 * budget comfortably below maxDuration — the fail-open only fires while
 * the function is still alive.
 */
// Named (not default) export on purpose: route.ts and route.test.ts both
// import the budget by name, so a default would only add indirection.
// eslint-disable-next-line import/prefer-default-export
export const STATS_READ_TIMEOUT_MS = 25_000;
