import type { WatchAccount } from '@/lib/analytics/types';

/**
 * Confirm-link state for the resend UI, derived from one signup account
 * row. `confirmExpired` is true only for a REAL past expiry on an
 * unconfirmed account; `confirmLinkSent` is true whenever a token
 * generation exists (live or expired — issue writes hash + expiry
 * together, consume clears both). Missing rows and confirmed accounts
 * read {false, false}. Corrupt clocks (unparseable expiry) read
 * {false, false} when no token hash is present, or {false, true} when a
 * token hash exists (link was issued but expiry is corrupted —
 * fail-closed on expiry, link-sent detected from token presence).
 * Display-only input: callers degrade transient read failures to
 * {false, false} (logged loudly) instead of 500ing polling loops over
 * garnish.
 *
 * Single home for a rule consumed in two places — the watch/status route
 * (poll source of truth) and the SiteNav SSR seed (first paint). It used
 * to live as two hand-synced copies with a "update here too" comment;
 * any future rule change lands here once and both sides follow (each
 * still pinned by its own tests).
 */
export interface ConfirmLinkState {
  confirmExpired: boolean;
  confirmLinkSent: boolean;
}

export const resolveConfirmLinkState = (
  account: WatchAccount | null,
): ConfirmLinkState => {
  if (account === null || account.confirmedAt !== null) {
    return { confirmExpired: false, confirmLinkSent: false };
  }
  const linkSent = (account.confirmTokenHash ?? null) !== null;
  if (account.confirmExpiresAt === null) {
    return { confirmExpired: false, confirmLinkSent: linkSent };
  }
  return {
    confirmExpired: Date.parse(account.confirmExpiresAt) <= Date.now(),
    confirmLinkSent: linkSent,
  };
};
