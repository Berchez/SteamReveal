import { act, renderHook, waitFor } from '@testing-library/react';
import useGamersClubName from './useGamersClubName';
import {
  clearFriendGcNames,
  getFriendGcName,
} from '@/app/templates/Home/shared/analytics/friendGcNameStore';
import {
  getGcServiceStatus,
  resetGcServiceStatus,
} from '@/app/templates/Home/shared/analytics/gcServiceStatus';

jest.mock('next-intl', () => ({
  useLocale: () => mockUseLocale(),
}));

const mockUseLocale = jest.fn(() => 'pt');

const mockFetch = jest.fn();

const setCountry = (country: string | null) => {
  document.cookie =
    'steamreveal_country=; Max-Age=0; path=/';
  if (country) {
    document.cookie = `steamreveal_country=${country}; path=/`;
  }
};

const jsonResponse = (gcName: string | null) =>
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ steamId: '76561198000000001', gcName }),
  });

describe('useGamersClubName', () => {
  const steamId = '76561198000000001';

  beforeEach(() => {
    clearFriendGcNames();
    resetGcServiceStatus();
    mockFetch.mockReset();
    mockUseLocale.mockReturnValue('pt');
    // fetch is a global, swapped for a mock per test
    global.fetch = mockFetch;
    setCountry('BR');
  });

  it('posts allowScrape=true for Brazil and stores a CONFIRMED name', async () => {
    mockUseLocale.mockReturnValue('pt');
    jsonResponse('aliceCS');

    const { result } = renderHook(() => useGamersClubName(steamId));

    await waitFor(() => expect(result.current.name).toBe('aliceCS'));
    expect(result.current.isLoading).toBe(false);
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/getGamersClubName',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ steamId, allowScrape: true }),
      }),
    );
    expect(getFriendGcName(steamId)).toBe('aliceCS');
  });

  it('never stores a null result (a miss stays a miss)', async () => {
    mockUseLocale.mockReturnValue('pt');
    jsonResponse(null);

    const { result } = renderHook(() => useGamersClubName(steamId));

    // name starts as null — wait for the fetch to actually complete instead.
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.name).toBeNull();
    expect(getFriendGcName(steamId)).toBeUndefined();
  });

  it('posts allowScrape=false for non-Brazilian visitors but still accepts a cached name', async () => {
    mockUseLocale.mockReturnValue('en');
    setCountry('US');
    jsonResponse('aliceCS');

    const { result } = renderHook(() => useGamersClubName(steamId));

    await waitFor(() => expect(result.current.name).toBe('aliceCS'));
    expect(mockFetch).toHaveBeenCalledWith(
      '/api/getGamersClubName',
      expect.objectContaining({
        body: JSON.stringify({ steamId, allowScrape: false }),
      }),
    );
    expect(getFriendGcName(steamId)).toBe('aliceCS');
  });

  it('surfaces a non-ok response as an error without touching the store', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

    const { result } = renderHook(() => useGamersClubName(steamId));

    await waitFor(() => expect(result.current.error).toBe('500'));
    expect(result.current.name).toBeNull();
    expect(result.current.isLoading).toBe(false);
    expect(getFriendGcName(steamId)).toBeUndefined();
  });

  it('skips the request entirely for an empty steamId', async () => {
    const { result } = renderHook(() => useGamersClubName(''));

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('skips the request entirely when disabled (logged-out premium gate)', async () => {
    const { result } = renderHook(() =>
      useGamersClubName(steamId, { enabled: false }),
    );

    expect(mockFetch).not.toHaveBeenCalled();
    expect(result.current).toEqual({
      name: null,
      isLoading: false,
      error: null,
      unavailable: false,
    });
  });

  it('reports the GC scraper as unavailable when the API says so', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        steamId,
        gcName: null,
        unavailable: true,
      }),
    });

    const { result } = renderHook(() => useGamersClubName(steamId));

    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(getGcServiceStatus()).toBe('unavailable');
  });

  it('reports the GC scraper as available when the API answers', async () => {
    jsonResponse(null);

    const { result } = renderHook(() => useGamersClubName(steamId));

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.unavailable).toBe(false);
    expect(getGcServiceStatus()).toBe('available');
  });

  it('starts fetching when enabled flips from false to true', async () => {
    jsonResponse('aliceCS');

    const { rerender, result } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useGamersClubName(steamId, { enabled }),
      { initialProps: { enabled: false } },
    );

    expect(mockFetch).not.toHaveBeenCalled();
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.name).toBe('aliceCS'));
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a cancelled (steamId-changed) response never writes stale state or the store', async () => {
    let resolveFirst: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    // The rerender below fires a SECOND fetch for the new id — give it a
    // benign (non-ok) response so it doesn't crash the effect.
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });

    const { rerender, result } = renderHook(
      ({ id }: { id: string }) => useGamersClubName(id),
      { initialProps: { id: steamId } },
    );

    rerender({ id: '76561198000000002' });

    await act(async () => {
      resolveFirst!({
        ok: true,
        json: async () => ({ steamId, gcName: 'stale-name' }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.name).toBeNull();
    expect(getFriendGcName(steamId)).toBeUndefined();
  });
});
