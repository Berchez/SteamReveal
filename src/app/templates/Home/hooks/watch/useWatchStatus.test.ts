import { act, renderHook } from '@testing-library/react';

import { toast } from 'react-toastify';

import { useWatchStatus } from './useWatchStatus';

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

const jsonResponse = (status: string) =>
  ({
    ok: true,
    json: async () => ({ status }),
  }) as Response;

describe('useWatchStatus', () => {
  let fetchMock: jest.Mock;

  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    fetchMock = jest.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const render = (props: {
    steamId?: string | null;
    enabled?: boolean;
  } = {}) =>
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
        delete (document as unknown as Record<string, unknown>)
          .visibilityState;
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

  it('resets per steamId (switching profiles never toasts stale transitions)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse('pending'))
      .mockResolvedValue(jsonResponse('active'));

    const { result, rerender } = render({ steamId: STEAM_A });
    await flushInitialFetch();
    expect(result.current.status).toBe('pending');

    rerender({ steamId: STEAM_B, enabled: true });
    await flushInitialFetch();

    // B's first fetch is already active with a null prev: no toast, even
    // though A was mid-pending moments ago.
    expect(result.current.status).toBe('active');
    expect(mockedToast.success).not.toHaveBeenCalled();
  });
});
