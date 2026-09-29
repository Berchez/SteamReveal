import { useCallback, useEffect, useRef } from 'react';
import type { ModalKind } from '@/lib/analytics/types';
import { trackModalEvent } from './modalAnalytics';

interface UseModalAnalyticsOptions {
  onClose: () => void;
  dontAskAgain: () => void;
  /**
   * Gate for modals that resolve visibility asynchronously (SupportMe
   * renders null until locale resolution lands — an unguarded mount
   * effect would count a display the user never saw). False on mount
   * simply defers the beacon until the first true render; the ref guard
   * below still holds it to exactly one.
   */
  enabled?: boolean;
}

/**
 * Shared promo-modal engagement wiring (SponsorMe / SupportMe /
 * login-prompt): one `shown` beacon per display plus close/dismiss/CTA
 * handlers that wrap the parent callbacks.
 *
 * Impression semantics: exactly once per component lifetime. Ref-guarded
 * (not state-guarded) so React 18 StrictMode's setup→cleanup→setup
 * double effect in dev doesn't double-count the same display; combined
 * with `enabled`, a modal that mounts hidden fires on its first visible
 * render instead. Handlers are memoized (useCallback) so keyboard paths
 * (LoginPrompt's Esc listener) don't re-subscribe while the parent
 * callbacks are stable — with an inline parent arrow they re-create per
 * render, which is harmless (effect cleanup swaps the listener) but not
 * free. Callers that re-render hot should stabilize onClose/dontAskAgain.
 */
// Named (not default) export on purpose: the three modal components plus
// tests import it by name, matching the sibling helpers in loginFunnel.ts
// and modalAnalytics.ts.
// eslint-disable-next-line import/prefer-default-export
export function useModalAnalytics(
  modal: ModalKind,
  { onClose, dontAskAgain, enabled = true }: UseModalAnalyticsOptions,
) {
  const shownRef = useRef(false);
  useEffect(() => {
    if (!enabled || shownRef.current) {
      return;
    }
    shownRef.current = true;
    trackModalEvent(modal, 'shown');
  }, [enabled, modal]);

  // CTA stays unguarded on purpose: every click IS a CTA click (the link
  // opens a tab, the modal stays mounted — raw counts philosophy).
  const handleCta = useCallback(() => {
    trackModalEvent(modal, 'cta_clicked');
  }, [modal]);

  // Terminal actions (the modal is leaving by definition): a fast
  // double-click fires both handlers before the unmount lands, so each
  // side guards itself to exactly one beacon. Kept per-action (not one
  // shared flag) so a close-then-dismiss race still records both exits.
  const closedRef = useRef(false);
  const dismissedRef = useRef(false);

  const handleClose = useCallback(() => {
    if (!closedRef.current) {
      closedRef.current = true;
      trackModalEvent(modal, 'closed');
    }
    onClose();
  }, [modal, onClose]);

  const handleDismiss = useCallback(() => {
    if (!dismissedRef.current) {
      dismissedRef.current = true;
      trackModalEvent(modal, 'dismissed');
    }
    dontAskAgain();
  }, [modal, dontAskAgain]);

  return { handleCta, handleClose, handleDismiss };
}
