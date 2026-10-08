import {
  HISTORY_PAGE_DEFAULT_LIMIT,
  HISTORY_PAGE_MAX_LIMIT,
  HISTORY_PAGE_SIZE,
  SEARCHER_LINK_TTL_MS,
} from './historyLimits';

describe('historyLimits (shared client/server paging budget)', () => {
  it('keeps the default inside the max (modal window never over-fetches past the server clamp)', () => {
    expect(HISTORY_PAGE_DEFAULT_LIMIT).toBeGreaterThan(0);
    expect(HISTORY_PAGE_MAX_LIMIT).toBeGreaterThanOrEqual(
      HISTORY_PAGE_DEFAULT_LIMIT,
    );
  });

  it('keeps the max at the inbox-scale budget (one cheap indexed query per page)', () => {
    // Deliberately the same 50 as WATCH_INBOX_MAX_LIMIT: same cost class,
    // same dropdown-adjacent surface. Bump consciously, not by drift.
    expect(HISTORY_PAGE_MAX_LIMIT).toBe(50);
  });

  it('requests the full server window per page (SIZE decoupled from the clamp)', () => {
    expect(HISTORY_PAGE_SIZE).toBeLessThanOrEqual(HISTORY_PAGE_MAX_LIMIT);
    expect(HISTORY_PAGE_SIZE).toBe(50);
  });

  it('pins the attribution TTL both enforcers share (purge + read cutoff)', () => {
    // 12 months, stated in words by the modal privacy note and applied
    // physically by the bot purge and logically by the read path.
    expect(SEARCHER_LINK_TTL_MS).toBe(365 * 24 * 60 * 60 * 1000);
  });
});
