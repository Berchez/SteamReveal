import getAnalyticsSkipHeaders from '@/lib/analytics/skipHeaders';
import type {
  ModalEventKind,
  ModalKind,
} from '@/lib/analytics/types';

/**
 * Promo-modal engagement instrumentation, client side (SponsorMe /
 * SupportMe / login-prompt): one fire-and-forget beacon per modal event
 * (shown / cta_clicked / closed / dismissed) to POST
 * /api/recordAnalyticsModals.
 *
 * Counts only, so the beacon carries no identifiers at all (no session,
 * no search — see 018): no cookie plant, nothing to correlate back. The
 * one synchronous read on the path is the owner skip-password header
 * (localStorage, microseconds, skipped for regular visitors) — evaluated
 * with the fetch arguments before the first await, never after.
 *
 * Everything here is best-effort and never throws into the caller: a
 * missing fetch or dead network only loses a row.
 */
// Named (not default) export on purpose: the three modal components plus
// tests import it by name, matching the recordLoginCta-style helpers next
// door in loginFunnel.ts (a DAL function shares the old recordModalEvent
// name, so this one tracks instead of records).
// eslint-disable-next-line import/prefer-default-export
export const trackModalEvent = async (
  modal: ModalKind,
  event: ModalEventKind,
): Promise<void> => {
  try {
    if (typeof fetch !== 'function') return;
    await fetch('/api/recordAnalyticsModals', {
      method: 'POST',
      keepalive: true,
      headers: {
        'Content-Type': 'application/json',
        ...getAnalyticsSkipHeaders(),
      },
      body: JSON.stringify({ modal, event }),
    });
  } catch {
    // Best effort: analytics must never break the modal interaction.
  }
};
