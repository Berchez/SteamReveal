/**
 * Shared Watch inbox limits (WB-14) — single source of truth for the
 * frontend window and the API defaults, so the two can never drift apart
 * silently (a frontend-only bump would over-fetch past the server cap, a
 * backend-only bump would shrink every client's window without notice).
 */

export const WATCH_INBOX_DEFAULT_LIMIT = 20;

export const WATCH_INBOX_MAX_LIMIT = 50;
