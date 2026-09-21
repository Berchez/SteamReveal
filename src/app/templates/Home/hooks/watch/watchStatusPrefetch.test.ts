import { act } from '@testing-library/react';

import {
  clearWatchStatusPrefetch,
  getPrefetchedWatchStatus,
  prefetchWatchStatus,
  readPrefetchedWatchStatusBody,
  readWarmWatchStatusSnapshot,
} from './watchStatusPrefetch';

const okResponse = (body: unknown) =>
  ({
    ok: true,
    json: async () => body,
  }) as Response;

describe('readPrefetchedWatchStatusBody', () => {
  it('accepts a valid payload', () => {
    expect(
      readPrefetchedWatchStatusBody({
        status: 'pending',
        confirmExpired: true,
        confirmLinkSent: true,
      }),
    ).toEqual({
      status: 'pending',
      confirmExpired: true,
      confirmLinkSent: true,
    });
  });

  it('defaults missing flags to false', () => {
    expect(readPrefetchedWatchStatusBody({ status: 'active' })).toEqual({
      status: 'active',
      confirmExpired: false,
      confirmLinkSent: false,
    });
  });

  it('rejects unknown statuses and non-objects', () => {
    expect(readPrefetchedWatchStatusBody({ status: 'bogus' })).toBeNull();
    expect(readPrefetchedWatchStatusBody(null)).toBeNull();
    expect(readPrefetchedWatchStatusBody('pending')).toBeNull();
    expect(readPrefetchedWatchStatusBody(undefined)).toBeNull();
  });
});

describe('prefetchWatchStatus', () => {
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
    clearWatchStatusPrefetch();
  });

  const flush = async () => {
    await act(async () => {});
  };

  it('stores a valid payload for a later warm read', async () => {
    fetchMock.mockResolvedValue(
      okResponse({ status: 'pending', confirmExpired: false, confirmLinkSent: true }),
    );

    prefetchWatchStatus();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('/api/watch/status');
    expect(getPrefetchedWatchStatus()).toEqual({
      status: 'pending',
      confirmExpired: false,
      confirmLinkSent: true,
    });
  });

  it('single-flights rapid calls and skips while fresh', async () => {
    fetchMock.mockResolvedValue(okResponse({ status: 'none' }));

    prefetchWatchStatus();
    prefetchWatchStatus();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Fresh entry: another hover costs nothing.
    prefetchWatchStatus();
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('swallows fetch failures and non-ok responses', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    prefetchWatchStatus();
    await flush();
    expect(getPrefetchedWatchStatus()).toBeNull();

    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 } as Response);
    prefetchWatchStatus();
    await flush();
    expect(getPrefetchedWatchStatus()).toBeNull();
  });

  it('ignores invalid payloads', async () => {
    fetchMock.mockResolvedValue(okResponse({ status: 'bogus' }));
    prefetchWatchStatus();
    await flush();
    expect(getPrefetchedWatchStatus()).toBeNull();
  });

  it('expires entries after the TTL', async () => {
    fetchMock.mockResolvedValue(okResponse({ status: 'active' }));
    prefetchWatchStatus();
    await flush();
    expect(getPrefetchedWatchStatus()).not.toBeNull();

    act(() => {
      jest.advanceTimersByTime(16000);
    });
    expect(getPrefetchedWatchStatus()).toBeNull();
  });

  it('never throws when fetch is unavailable or throws synchronously', async () => {
    const originalFetch = global.fetch;
    global.fetch = undefined as unknown as typeof fetch;
    try {
      expect(() => prefetchWatchStatus()).not.toThrow();
      await act(async () => {});
    } finally {
      global.fetch = originalFetch;
    }
    expect(getPrefetchedWatchStatus()).toBeNull();

    fetchMock.mockImplementation(() => {
      throw new Error('sync boom');
    });
    expect(() => prefetchWatchStatus()).not.toThrow();
    await act(async () => {});
    expect(getPrefetchedWatchStatus()).toBeNull();
  });

  it('skips hidden tabs', async () => {
    const original = Object.getOwnPropertyDescriptor(
      document,
      'visibilityState',
    );
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });
    try {
      prefetchWatchStatus();
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (original !== undefined) {
        Object.defineProperty(document, 'visibilityState', original);
      } else {
        // jsdom exposes visibilityState on the prototype: remove the own
        // override so later tests see the default again instead of a
        // stuck 'hidden' (which would silently skip their prefetches).
        delete (document as unknown as Record<string, unknown>)
          .visibilityState;
      }
    }
  });
});

describe('readWarmWatchStatusSnapshot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    clearWatchStatusPrefetch();
  });

  afterEach(() => {
    jest.useRealTimers();
    clearWatchStatusPrefetch();
  });

  const flush = async () => {
    await act(async () => {});
  };

  it('returns blanks when nothing was prefetched', () => {
    expect(readWarmWatchStatusSnapshot()).toEqual({
      status: null,
      confirmExpired: false,
      confirmLinkSent: false,
    });
  });

  it('returns the prefetched values when fresh', async () => {
    const fetchMock = jest.fn(async () => ({
      ok: true,
      json: async () => ({
        status: 'active',
        confirmExpired: true,
        confirmLinkSent: true,
      }),
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    prefetchWatchStatus();
    await flush();

    expect(readWarmWatchStatusSnapshot()).toEqual({
      status: 'active',
      confirmExpired: true,
      confirmLinkSent: true,
    });
  });
});
