import { act, renderHook } from '@testing-library/react';
import useLoginPrompt, {
  LOGIN_PROMPT_SCORE_KEY,
  LOGIN_PROMPT_THRESHOLD,
  resetLoginPromptSessionCache,
} from './useLoginPrompt';

describe('useLoginPrompt (weighted scoring, SupportMe model)', () => {
  beforeEach(() => {
    resetLoginPromptSessionCache();
    window.localStorage.clear();
    jest.restoreAllMocks();
  });

  it('stays hidden below the threshold and accumulates across calls', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      const { result } = renderHook(() => useLoginPrompt());

      expect(result.current.showLoginPrompt).toBe(false);
      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });
      expect(result.current.showLoginPrompt).toBe(false);
      expect(window.localStorage.getItem(LOGIN_PROMPT_SCORE_KEY)).toBe('1');

      await act(async () => {
        result.current.handleShowLoginPrompt(LOGIN_PROMPT_THRESHOLD);
      });
      expect(result.current.showLoginPrompt).toBe(true);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('weights heavy calls more: a single cheater-report open (+3) counts triple', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '7');
      const { result } = renderHook(() => useLoginPrompt());

      await act(async () => {
        result.current.handleShowLoginPrompt(3);
      });

      expect(result.current.showLoginPrompt).toBe(true);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('close resets to zero (threshold must be re-earned)', () => {
    window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
    const { result } = renderHook(() => useLoginPrompt());

    act(() => {
      result.current.onCloseLoginPrompt();
    });

    expect(result.current.showLoginPrompt).toBe(false);
    expect(window.localStorage.getItem(LOGIN_PROMPT_SCORE_KEY)).toBe('0');
  });

  it('dismiss digs a deep negative debt (long cooldown, not permanent)', () => {
    const { result } = renderHook(() => useLoginPrompt());

    act(() => {
      result.current.onDismissLoginPrompt();
    });

    expect(result.current.showLoginPrompt).toBe(false);
    expect(Number(window.localStorage.getItem(LOGIN_PROMPT_SCORE_KEY))).toBeLessThan(0);
  });

  it('suppresses the prompt for logged-in users (single cached status check)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
      const { result } = renderHook(() => useLoginPrompt());

      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][0]).toBe('/api/watch/status');
      expect(result.current.showLoginPrompt).toBe(false);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('shows for logged-out users and caches the status (one fetch per page)', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
      const { result } = renderHook(() => useLoginPrompt());

      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });
      expect(result.current.showLoginPrompt).toBe(true);

      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('suppresses on 429/5xx (rate-limit/server error never reads as logged-out)', async () => {
    for (const status of [429, 500, 503]) {
      resetLoginPromptSessionCache();
      const fetchMock = jest
        .fn()
        .mockResolvedValue({ ok: false, status });
      (global as Record<string, unknown>).fetch = fetchMock;
      try {
        window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
        const { result } = renderHook(() => useLoginPrompt());

        await act(async () => {
          result.current.handleShowLoginPrompt(1);
        });

        expect(result.current.showLoginPrompt).toBe(false);
      } finally {
        delete (global as Record<string, unknown>).fetch;
      }
    }
  });

  it('coalesces concurrent threshold crossings into a single fetch', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 401 });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
      const { result } = renderHook(() => useLoginPrompt());

      await act(async () => {
        result.current.handleShowLoginPrompt(1);
        result.current.handleShowLoginPrompt(3);
      });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.showLoginPrompt).toBe(true);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('suppresses inside the login waiting room / auth-error landing (no fetch)', async () => {
    const fetchMock = jest.fn();
    (global as Record<string, unknown>).fetch = fetchMock;
    const originalUrl = window.location.href;
    try {
      for (const query of ['?login=waiting', '?auth=error']) {
        window.history.replaceState({}, '', `/${query}`);
        window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
        const { result, unmount } = renderHook(() => useLoginPrompt());

        await act(async () => {
          result.current.handleShowLoginPrompt(100);
        });

        expect(result.current.showLoginPrompt).toBe(false);
        unmount();
      }
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      window.history.replaceState({}, '', originalUrl);
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('retries after a transient unknown (errors are not cached)', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500 })
      .mockResolvedValueOnce({ ok: false, status: 401 });
    (global as Record<string, unknown>).fetch = fetchMock;
    try {
      window.localStorage.setItem(LOGIN_PROMPT_SCORE_KEY, '30');
      const { result } = renderHook(() => useLoginPrompt());

      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });
      expect(result.current.showLoginPrompt).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The 500 verdict was dropped, so the next crossing fetches again
      // and this time the 401 releases the popup.
      await act(async () => {
        result.current.handleShowLoginPrompt(1);
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current.showLoginPrompt).toBe(true);
    } finally {
      delete (global as Record<string, unknown>).fetch;
    }
  });

  it('suppresses (never crashes) when storage is blocked', () => {
    jest.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const setSpy = jest
      .spyOn(window.localStorage.__proto__, 'setItem')
      .mockImplementation(() => {});
    const { result } = renderHook(() => useLoginPrompt());

    act(() => {
      result.current.handleShowLoginPrompt(100);
    });

    // readScore degrades to -Infinity: 100 points still below threshold,
    // and nothing ("-Infinity") is persisted.
    expect(result.current.showLoginPrompt).toBe(false);
    expect(setSpy).not.toHaveBeenCalled();
  });
});
