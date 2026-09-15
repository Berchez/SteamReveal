import { act, renderHook } from '@testing-library/react';

import { toast } from 'react-toastify';

import { useWatchStatus } from './useWatchStatus';
import {
  clearWatchStatusPrefetch,
  prefetchWatchStatus,
} from './watchStatusPrefetch';

jest.mock('react-toastify', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

// Stable reference on purpose: the real next-intl useTranslations returns
// a memoized function, and this hook keys its polling effect on it. A
// fresh arrow per call would churn the effect (restarting the poll loop
// every render) and make every timing assertion flaky.
const mockTranslate = (key: string) => key;

jest.mock('next-intl', () => ({
  useTranslations: () => mockTranslate,
}));

const mockedToast = toast as unknown as {
  success: jest.Mock;
};

const STEAM_A = '76561198000000001';
const STEAM_B = '76561198000000002';

const jsonResponse = (status: string, extra: Record<string, unknown> = {}) =>
  ({
    ok: true,
    json: async () => ({ status, confirmLinkSent: false, ...extra }),
  }) as Response;

describe('useWatchStatus', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    clearWatchStatusPrefetch();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const render = (
    props: {
      steamId?: string | null;
      enabled?: boolean;
    } = {},
  ) =>
    renderHook(
      ({ steamId, enabled }) =>
        useWatchStatus({ steamId, enabled, pollIntervalMs: 5000 }),
      { initialProps: { steamId: STEAM_A, enabled: true, ...props } },
    );

  const flushPolls = async (count: number) => {
    // Repo-proven pattern (see VideoBackground/CheaterReport specs):
    // advance timers synchronously inside sync act(), then flush the
    // promise chains (fetch mocks) with an empty async act. The
    // `await act(async () => advanceTimersByTimeAsync())` combo deadlocks
    // here — do not "simplify" back to it.
    for (let i = 0; i < count; i += 1) {
      act(() => {
        jest.advanceTimersByTime(5000);
      });
      // eslint-disable-next-line no-await-in-loop
      await act(async () => {});
    }
  };

  it('pauses fetching while the tab is hidden and resumes when visible', async () => {
    fetchMock.mockResolvedValue(jsonResponse('pending'));
    const original = Object.getOwnPropertyDescriptor(
      document,
      'visibilityState',
    );
    const setVisibility = (value: string) => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        value,
      });
    };
    const restoreVisibility = () => {
      if (original) {
        Object.defineProperty(document, 'visibilityState', original);
      } else {
        delete (document as unknown as Record<string, unknown>).visibilityState;
      }
    };

    setVisibility('hidden');
    try {
      const { result, unmount } = render();
      await settleTimers(30000);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.status).toBeNull();

      setVisibility('visible');
      await settleTimers(10000);

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(result.current.status).toBe('pending');
      unmount();
    } finally {
      restoreVisibility();
    }
  });

  const flushInitialFetch = async () => {
    await act(async () => {});
  };

  const settleTimers = async (ms: number) => {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
    await flushInitialFetch();
  };

  it('stops and reports session-expired on 401 (logged out mid-use)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });

    const { result } = render();

    await flushInitialFetch();
    expect(result.current).toEqual({
      status: null,
      error: 'session-expired',
      confirmExpired: false,
      confirmLinkSent: false,
    });
    // Polling stopped: no more fetches no matter how long we wait.
    const calls = fetchMock.mock.calls.length;
    await flushPolls(3);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('fires the welcome toast exactly once on pending -> active', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValue(jsonResponse('active'));

    const { result } = render();

    await flushInitialFetch();
    expect(result.current.status).toBe('pending');
    expect(mockedToast.success).not.toHaveBeenCalled();

    await flushPolls(3);

    expect(result.current.status).toBe('active');
    expect(mockedToast.success).toHaveBeenCalledTimes(1);
    expect(mockedToast.success).toHaveBeenCalledWith('watchWelcome');
    // Polling stopped on active: no more fetches no matter how long we wait.
    const calls = fetchMock.mock.calls.length;
    await flushPolls(3);
    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('never toasts while staying pending, and keeps polling', async () => {
    fetchMock.mockResolvedValue(jsonResponse('pending'));

    const { result } = render();

    await flushPolls(3);

    expect(result.current.status).toBe('pending');
    expect(mockedToast.success).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('surfaces confirmExpired from the status payload (resend UI fuel)', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse('pending', { confirmExpired: true, confirmLinkSent: false }),
    );

    const { result, unmount } = render();
    await flushPolls(1);
    expect(result.current.confirmExpired).toBe(true);
    expect(result.current.confirmLinkSent).toBe(false);

    fetchMock.mockResolvedValue(
      jsonResponse('pending', { confirmExpired: false, confirmLinkSent: false }),
    );
    await flushPolls(1);
    expect(result.current.confirmExpired).toBe(false);
    unmount();
  });

  it('defaults confirmExpired to false when the field is absent (old deployments)', async () => {
    fetchMock.mockResolvedValue(jsonResponse('pending'));

    const { result, unmount } = render();
    await flushPolls(1);
    expect(result.current.confirmExpired).toBe(false);
    expect(result.current.confirmLinkSent).toBe(false);
    unmount();
  });

  it('does not toast when the first load is already active', async () => {
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const { result } = render();

    await flushInitialFetch();

    expect(result.current.status).toBe('active');
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('does not toast after a reload that lands directly on active', async () => {
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const first = render();
    await flushInitialFetch();
    expect(first.result.current.status).toBe('active');
    first.unmount();

    const second = render();
    await flushInitialFetch();
    expect(second.result.current.status).toBe('active');
    expect(mockedToast.success).not.toHaveBeenCalled();
    second.unmount();
  });

  it('cleans timers up on unmount (no more fetches)', async () => {
    fetchMock.mockResolvedValue(jsonResponse('pending'));

    const { unmount } = render();
    await flushInitialFetch();
    const calls = fetchMock.mock.calls.length;

    unmount();
    await settleTimers(30000);

    expect(fetchMock.mock.calls.length).toBe(calls);
  });

  it('does nothing when disabled or without steamId', async () => {
    const { unmount: unmountDisabled } = render({ enabled: false });
    const { unmount: unmountEmpty } = render({ steamId: null });

    await settleTimers(30000);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedToast.success).not.toHaveBeenCalled();
    unmountDisabled();
    unmountEmpty();
  });

  it('flags invalid steamId without fetching', async () => {
    const { result } = render({ steamId: 'nope' });

    await settleTimers(30000);

    expect(result.current.error).toBe('invalid');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('stops on definitive 400 and surfaces the error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400 });

    const { result } = render();

    await flushInitialFetch();

    expect(result.current.error).toBe('invalid');
    const calls = fetchMock.mock.calls.length;
    await flushPolls(3);
    expect(fetchMock.mock.calls.length).toBe(calls);
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('keeps polling through transient network failures', async () => {
    fetchMock
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(jsonResponse('pending'));

    const { result } = render();

    // First fetch fails at t=0, backoff pushes the retry to t=10: one more
    // round is needed for it to resolve compared to the flat cadence.
    await flushPolls(3);

    expect(result.current.status).toBe('pending');
    expect(result.current.error).toBeNull();
    expect(mockedToast.success).not.toHaveBeenCalled();
  });

  it('backs off on 429 instead of hammering at full cadence', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 });

    render();

    // t=0 initial fetch, then backoff 10s, 20s, 40s... (base 5s doubling,
    // capped at 60s) — never the flat 5s cadence.
    await flushInitialFetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settleTimers(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await settleTimers(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settleTimers(10000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await settleTimers(10000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('resets the backoff after a successful poll', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 429 })
      .mockResolvedValue(jsonResponse('pending'));

    render();

    await flushInitialFetch();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // First retry waits the backed-off 10s, not 5s...
    await settleTimers(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await settleTimers(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // ...and the success resets the cadence to the flat 5s.
    await settleTimers(5000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('starts warm from a fresh prefetch instead of the skeleton path', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: true,
      }),
    );

    prefetchWatchStatus();
    await act(async () => {});

    // The mount poll would answer something else; the warm first paint must
    // win regardless (the poll still revalidates right after).
    fetchMock.mockResolvedValue(jsonResponse('none'));

    const { result } = render();
    expect(result.current.status).toBe('pending');
    expect(result.current.confirmExpired).toBe(false);
    expect(result.current.confirmLinkSent).toBe(true);

    // Settle the mount poll so no state update leaks past the test.
    await flushPolls(1);
  });

  it('still toasts when a warm pending flips to active on the first poll', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: true,
      }),
    );

    prefetchWatchStatus();
    await act(async () => {});

    // Activation lands in the hover→click window: the first real poll sees
    // it, and the toast must fire exactly once — the warm seed must count
    // as the "previous" pending, not as a fresh load.
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const { result } = render();
    expect(result.current.status).toBe('pending');

    await flushPolls(1);
    expect(result.current.status).toBe('active');
    expect(mockedToast.success).toHaveBeenCalledTimes(1);
  });

  it('resets per steamId (switching profiles never toasts stale transitions)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValue(jsonResponse('active'));

    const { result, rerender } = render({ steamId: STEAM_A });
    await flushInitialFetch();
    expect(result.current.status).toBe('pending');

    // A's pending -> active transition SHOULD toast once
    await flushPolls(1);
    expect(result.current.status).toBe('active');
    expect(mockedToast.success).toHaveBeenCalledTimes(1);

    // Switch to B: the prefetch cache is deliberately NOT keyed by steamId
    // (/api/watch/status is self-scoped — one identity per session, so the
    // cache can only ever describe the logged-in user). B therefore seeds
    // from A's synced 'active': no toast fires (prev='active',
    // next='active'). If this hook is ever reused to inspect OTHER
    // profiles, the cache must become keyed first — see the module header
    // of watchStatusPrefetch.ts.
    rerender({ steamId: STEAM_B, enabled: true });
    await flushInitialFetch();

    expect(result.current.status).toBe('active');
    // Total toasts still 1 (only A's transition)
    expect(mockedToast.success).toHaveBeenCalledTimes(1);
  });

  it('does not double-toast when remounting within TTL after pending->active', async () => {
    // Simulate: hover -> prefetch gets pending -> open dropdown -> poll resolves active
    // -> close -> reopen within TTL -> poll resolves active again
    // The welcome toast must fire only ONCE across the entire lifecycle.

    // First: prefetch returns pending
    fetchMock.mockResolvedValue(
      jsonResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: true,
      }),
    );

    prefetchWatchStatus();
    await act(async () => {});

    // Open: first poll resolves active (activation happens)
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const { result, unmount } = render({ steamId: STEAM_A });
    await flushPolls(1);
    expect(result.current.status).toBe('active');
    expect(mockedToast.success).toHaveBeenCalledTimes(1);

    // Close: unmount (simulates dropdown close)
    unmount();

    // Reopen within TTL: the cache still has the original 'pending' from prefetch,
    // BUT our fix syncs the cache on live poll, so it should now have 'active'
    // The hook should seed prevStatusRef from 'active', so no second toast.
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const { result: result2 } = render({ steamId: STEAM_A });
    expect(result2.current.status).toBe('active');

    // The remount triggers a mount poll, which will also return active
    await flushPolls(1);

    // Toast must fire ONLY once across the entire lifecycle
    expect(mockedToast.success).toHaveBeenCalledTimes(1);
  });

  it('keeps absent flag fields at their resolved values in the synced cache', async () => {
    // Partial-rollout server: full flags on prefetch, then a live poll
    // WITHOUT the flag fields at all. Rendered state keeps the previous
    // trues — and the cache sync must do the same, or the next warm open
    // would hide the resend UI until a later poll corrects it.
    fetchMock.mockResolvedValue(
      jsonResponse('pending', {
        confirmExpired: true,
        confirmLinkSent: true,
      }),
    );

    prefetchWatchStatus();
    await act(async () => {});

    // Raw body with no flag keys (jsonResponse always sets confirmLinkSent,
    // so this one is built by hand).
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending' }),
    } as Response);

    const { result, unmount } = render({ steamId: STEAM_A });
    await flushPolls(1);
    expect(result.current.status).toBe('pending');
    expect(result.current.confirmExpired).toBe(true);
    expect(result.current.confirmLinkSent).toBe(true);
    unmount();

    // Reopen within the TTL: the synced cache must still carry the resolved
    // trues, not body-absent falses.
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ status: 'pending' }),
    } as Response);

    const { result: result2 } = render({ steamId: STEAM_A });
    expect(result2.current.confirmExpired).toBe(true);
    expect(result2.current.confirmLinkSent).toBe(true);

    await flushPolls(1);
  });

  it('aborts the in-flight poll on unmount: fast close→reopen toasts once', async () => {
    // Race: warm pending in cache, mount A starts a poll that hangs (slow
    // network), user closes (unmount) and reopens (mount B) before it
    // resolves, then both fetches answer 'active'. Without the unmount
    // abort, BOTH callbacks observe pending→active and toast — two toasts
    // for one activation. With it, only the surviving mount speaks.
    fetchMock.mockResolvedValue(
      jsonResponse('pending', {
        confirmExpired: false,
        confirmLinkSent: true,
      }),
    );

    prefetchWatchStatus();
    await act(async () => {});

    // A's mount poll hangs; everything after answers active.
    let releaseA!: (value: Response) => void;
    fetchMock.mockImplementationOnce(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((resolve, reject) => {
          releaseA = resolve;
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }),
    );
    fetchMock.mockResolvedValue(jsonResponse('active'));

    const { unmount } = render({ steamId: STEAM_A });
    // A's poll is in flight; closing must abort it.
    unmount();

    const { result } = render({ steamId: STEAM_A });
    await flushPolls(2);
    expect(result.current.status).toBe('active');

    // The dead ancestor's fetch settles late — must stay silent.
    releaseA(jsonResponse('active') as Response);
    await act(async () => {});
    await flushPolls(1);

    expect(mockedToast.success).toHaveBeenCalledTimes(1);
  });
});
