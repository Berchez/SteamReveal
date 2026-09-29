import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { useModalAnalytics } from './useModalAnalytics';
import { trackModalEvent } from './modalAnalytics';

// The hook delegates the network to trackModalEvent (fetch/keepalive
// pinned in modalAnalytics.test.ts) — here only the wiring is asserted:
// once-per-display, the enabled gate, and the parent-callback wrapping.
jest.mock('./modalAnalytics', () => ({
  trackModalEvent: jest.fn(),
}));

describe('useModalAnalytics (shared promo-modal engagement wiring)', () => {
  const onClose = jest.fn();
  const dontAskAgain = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fires shown exactly once per display, StrictMode double-mount included', () => {
    // Real <React.StrictMode>: dev double-invokes effects
    // (setup→cleanup→setup) — the ref guard, not the test timing, must
    // hold the count at one.
    const { result, rerender } = renderHook(
      () => useModalAnalytics('sponsor', { onClose, dontAskAgain }),
      {
        wrapper: ({ children }: { children: React.ReactNode }) => (
          <React.StrictMode>{children}</React.StrictMode>
        ),
      },
    );

    expect(trackModalEvent).toHaveBeenCalledTimes(1);
    expect(trackModalEvent).toHaveBeenCalledWith('sponsor', 'shown');

    // Re-renders (parent state churn) must not re-fire.
    rerender();
    rerender();
    expect(trackModalEvent).toHaveBeenCalledTimes(1);
    expect(result.current.handleCta).toBeDefined();
  });

  it('defers shown until enabled flips true (async visibility)', () => {
    const { rerender } = renderHook(
      ({ enabled }) =>
        useModalAnalytics('support', { onClose, dontAskAgain, enabled }),
      { initialProps: { enabled: false } },
    );

    expect(trackModalEvent).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(trackModalEvent).toHaveBeenCalledTimes(1);
    expect(trackModalEvent).toHaveBeenCalledWith('support', 'shown');

    // Flapping back and forth never re-fires.
    rerender({ enabled: false });
    rerender({ enabled: true });
    expect(trackModalEvent).toHaveBeenCalledTimes(1);
  });

  it('wraps CTA/close/dismiss around the parent callbacks', () => {
    const { result } = renderHook(() =>
      useModalAnalytics('login_prompt', { onClose, dontAskAgain }),
    );
    (trackModalEvent as jest.Mock).mockClear();

    act(() => {
      result.current.handleCta();
    });
    expect(trackModalEvent).toHaveBeenCalledWith(
      'login_prompt',
      'cta_clicked',
    );
    expect(onClose).not.toHaveBeenCalled();

    act(() => {
      result.current.handleClose();
    });
    expect(trackModalEvent).toHaveBeenCalledWith('login_prompt', 'closed');
    expect(onClose).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.handleDismiss();
    });
    expect(trackModalEvent).toHaveBeenCalledWith('login_prompt', 'dismissed');
    expect(dontAskAgain).toHaveBeenCalledTimes(1);
  });

  it('guards terminal actions to one beacon each (fast double-click)', () => {
    const { result } = renderHook(() =>
      useModalAnalytics('sponsor', { onClose, dontAskAgain }),
    );
    (trackModalEvent as jest.Mock).mockClear();

    act(() => {
      result.current.handleClose();
      result.current.handleClose();
    });
    act(() => {
      result.current.handleDismiss();
      result.current.handleDismiss();
    });

    // Parent callbacks still run every time (pre-existing behavior — the
    // guard covers the metric, never the product action)...
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(dontAskAgain).toHaveBeenCalledTimes(2);
    // ...while each exit beacon fires exactly once.
    expect(
      (trackModalEvent as jest.Mock).mock.calls.filter(
        ([, event]) => event === 'closed',
      ),
    ).toHaveLength(1);
    expect(
      (trackModalEvent as jest.Mock).mock.calls.filter(
        ([, event]) => event === 'dismissed',
      ),
    ).toHaveLength(1);
  });

  it('keeps stable handler identities across re-renders (keyboard deps)', () => {
    const { result, rerender } = renderHook(() =>
      useModalAnalytics('login_prompt', { onClose, dontAskAgain }),
    );
    const first = result.current;

    rerender();

    // An Esc listener depending on handleClose must not re-subscribe.
    expect(result.current.handleClose).toBe(first.handleClose);
    expect(result.current.handleCta).toBe(first.handleCta);
    expect(result.current.handleDismiss).toBe(first.handleDismiss);
  });
});
