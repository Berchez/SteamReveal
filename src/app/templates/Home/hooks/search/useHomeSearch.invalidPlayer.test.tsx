import { renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import useHomeSearch from './useHomeSearch';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('next/navigation', () => ({
  useParams: () => ({ steamId: 'target-steam-id' }),
  useSearchParams: () => new URLSearchParams(),
}));

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

jest.mock('../../shared/cache/homeCache', () => ({
  getCachedSearch: jest.fn(() => undefined),
  setCachedSearch: jest.fn(),
}));

jest.mock('../../shared/analytics/homeAnalyticsUtils', () => ({
  recordAnalytics: jest.fn(async () => 'search-id'),
  getRequesterDevice: jest.fn(() => 'desktop'),
  getRequesterCountry: jest.fn(() => 'BR'),
  getRequesterBrowserLanguage: jest.fn(() => 'en-US'),
}));

jest.mock('./homeUtils', () => ({
  getLocationDetails: jest.fn(async () => ({})),
  getCitiesNames: jest.fn(async (scored: Record<string, number>) =>
    Object.entries(scored),
  ),
  sortCitiesByScore: jest.fn((scored: Record<string, number>) => scored),
}));

jest.mock('./probabilityMath', () => ({
  computeCloseFriendsProbability: jest.fn((friends: unknown[]) => friends),
  computeCityScores: jest.fn(() => ({})),
  computeLocationProbabilities: jest.fn((cities: unknown[]) => cities),
}));

const makeRunGuard = () => {
  let currentRun = 0;

  return {
    reserveNewRun: jest.fn(() => {
      currentRun += 1;
      return currentRun;
    }),
    isCurrentRun: jest.fn((runId: number) => runId === currentRun),
  };
};

describe('useHomeSearch - invalid player clears loading flags', () => {
  it('resets all loading flags when getUserInfo fails', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.reject(new Error('not found'));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const runGuard = makeRunGuard();

    const { result } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
      }),
    );

    await waitFor(() => {
      // Eventually the hook should clear loading flags
      expect(result.current.isLoading.myCard).toBe(false);
      expect(result.current.isLoading.friendsCards).toBe(false);
      expect(result.current.isLoading.location).toBe(false);
    });

    expect(result.current.possibleLocationJson).toBeUndefined();
    expect(result.current.closeFriendsJson).toBeUndefined();
  });

  it('resolves both lists to [] when friends fail after the profile resolved (no infinite skeleton)', async () => {
    // Partial failure: the target card rendered, so LocationSection and
    // FriendsSection stay mounted. Leaving the lists `undefined` would show
    // skeletons forever — they must settle on `[]` (empty real state).
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: {
            targetInfo: { steamID: 'target-steam-id', nickname: 'x' },
          },
        });
      }
      if (url === '/api/getCloseFriends') {
        return Promise.reject(new Error('private'));
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const runGuard = makeRunGuard();

    const { result } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading.friendsCards).toBe(false);
      expect(result.current.isLoading.location).toBe(false);
    });

    expect(result.current.closeFriendsJson).toEqual([]);
    expect(result.current.possibleLocationJson).toEqual([]);
    // The profile itself resolved, so the player sections stay mounted.
    expect(result.current.hasNoDataYet).toBe(false);
    // A failed (non-private) request leaves visibility unknown — it must
    // NOT claim 'empty', or the UI would falsely state the profile has no
    // friends (see FriendsSection/CheaterReport).
    expect(result.current.friendsVisibility).toBeUndefined();
  });

  it('continues the pipeline in degraded mode when the friends list is private', async () => {
    // Private list (the server 400): friends settle as [] + visibility
    // 'private', but location/analytics/searchId still run — the search is
    // degraded, not aborted.
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: {
            targetInfo: { steamID: 'target-steam-id', nickname: 'x' },
          },
        });
      }
      if (url === '/api/getCloseFriends') {
        // Realistic axios shape: generic message, structured code + copy
        // nested under response.data.error (what errorResponse serializes).
        return Promise.reject(
          Object.assign(new Error('Request failed with status code 400'), {
            response: {
              status: 400,
              data: {
                error: {
                  message: "Target's friends list is private or inaccessible.",
                  code: 'FRIENDS_LIST_PRIVATE',
                },
              },
            },
          }),
        );
      }
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const runGuard = makeRunGuard();

    const { result } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading.friendsCards).toBe(false);
      expect(result.current.isLoading.location).toBe(false);
    });

    await waitFor(() => {
      expect(result.current.searchId).toBe('search-id');
    });

    expect(result.current.closeFriendsJson).toEqual([]);
    expect(result.current.friendsVisibility).toBe('private');
    expect(result.current.possibleLocationJson).toEqual([]);
    expect(result.current.hasNoDataYet).toBe(false);

    const analytics = jest.requireMock(
      '../../shared/analytics/homeAnalyticsUtils',
    ) as { recordAnalytics: jest.Mock };
    expect(analytics.recordAnalytics).toHaveBeenCalled();
    const calls = analytics.recordAnalytics.mock.calls;
    const meta = calls[calls.length - 1][3] as Record<string, unknown>;
    expect(meta.friendsVisibility).toBe('private');

    // Cache round-trip: the degraded search is cached WITH its visibility
    // so a repeat visit restores the private empty-state without refetching.
    const cache = jest.requireMock('../../shared/cache/homeCache') as {
      setCachedSearch: jest.Mock;
    };
    expect(cache.setCachedSearch).toHaveBeenCalledWith(
      expect.anything(),
      'target-steam-id',
      expect.objectContaining({ friendsVisibility: 'private' }),
    );
  });

  it('flags a resolved empty list as empty (genuinely friendless, not private)', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: {
            targetInfo: { steamID: 'target-steam-id', nickname: 'x' },
          },
        });
      }
      if (url === '/api/getCloseFriends') {
        return Promise.resolve({ data: { closeFriends: [] } });
      }
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const runGuard = makeRunGuard();

    const { result } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.searchId).toBe('search-id');
    });

    expect(result.current.closeFriendsJson).toEqual([]);
    expect(result.current.friendsVisibility).toBe('empty');
  });

  it('resolves the location list to [] when location fails after friends resolved', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: {
            targetInfo: { steamID: 'target-steam-id', nickname: 'x' },
          },
        });
      }
      if (url === '/api/getCloseFriends') {
        return Promise.resolve({
          data: {
            closeFriends: [{ friend: { steamID: 'f1' }, count: 1 }],
          },
        });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const homeUtils = jest.requireMock('./homeUtils') as {
      getCitiesNames: jest.Mock;
    };
    homeUtils.getCitiesNames.mockRejectedValueOnce(new Error('geo down'));

    const runGuard = makeRunGuard();

    const { result } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
      }),
    );

    await waitFor(() => {
      expect(result.current.isLoading.location).toBe(false);
    });

    expect(result.current.closeFriendsJson).toHaveLength(1);
    expect(result.current.possibleLocationJson).toEqual([]);
  });
});
