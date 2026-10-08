/**
 * Shared "my search history" paging limits — single source of truth for
 * the modal window and the API defaults, so the two can never drift
 * apart silently (same pattern as @/lib/watch/limits for the inbox).
 *
 * Client-safe by construction: this module imports NOTHING (no
 * @libsql/client, no server code), so both the DAL (db.ts) and the
 * client modal can import it without dragging server code into the
 * browser bundle.
 */

export const HISTORY_PAGE_DEFAULT_LIMIT = 20;

export const HISTORY_PAGE_MAX_LIMIT = 50;

/**
 * What the modal actually requests per page: the full server window.
 * Separate constant (not just MAX) so a future "smaller first paint"
 * tune doesn't silently move the server clamp, and vice versa.
 */
export const HISTORY_PAGE_SIZE = 50;

/**
 * Search-history attribution TTL (12 months): searcher_steam_id links
 * older than this are dead — the bot's daily purge de-attributes them
 * physically, AND listSearcherSearches hides them at read time, so the
 * "links expire after 12 months" UI promise holds even if the bot is
 * down for weeks. Single source of truth for both sides (plus the
 * modal's privacy note, which states the same 12 months in words).
 */
export const SEARCHER_LINK_TTL_MS = 365 * 24 * 60 * 60 * 1000;
