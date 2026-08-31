import { renderHook, act, waitFor } from '@testing-library/react';

import axios from 'axios';

import useHomeSearch from './useHomeSearch';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

jest.mock('next/navigation', () => ({
  useParams: () => ({ steamId: 'target-steam-id' }),
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

describe('useHomeSearch - location loading flag', () => {
  it('keeps isLoading.location true after friendsCards resolves, until possibleLocationJson is actually set', async () => {
    let resolveCloseFriends: (value: unknown) => void = () => {};
    let resolveCitiesNames: (value: [string, number][]) => void = () => {};

    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: {
            targetInfo: {
              steamID: 'target-steam-id',
              nickname: 'x',
            },
          },
        });
      }

      if (url === '/api/getCloseFriends') {
        return new Promise((resolve) => {
          resolveCloseFriends = resolve;
        });
      }

      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const homeUtils = jest.requireMock('./homeUtils') as {
      getCitiesNames: jest.Mock;
    };

    homeUtils.getCitiesNames.mockImplementation(
      (_scored: Record<string, number>) =>
        new Promise<[string, number][]>((resolve) => {
          resolveCitiesNames = resolve;
        }),
    );

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
      expect(result.current.isLoading.myCard).toBe(false);
    });

    expect(result.current.isLoading.location).toBe(true);

    await act(async () => {
      resolveCloseFriends({
        data: {
          closeFriends: [],
        },
      });
    });

    // getCloseFriendsJson has resolved, so friendsCards is no longer loading.
    // However, getPossibleLocation is now waiting for getCitiesNames().
    await waitFor(() => {
      expect(result.current.isLoading.friendsCards).toBe(false);
    });

    expect(result.current.possibleLocationJson).toBeUndefined();
    expect(result.current.isLoading.location).toBe(true);

    await act(async () => {
      resolveCitiesNames([]);
    });

    await waitFor(() => {
      expect(result.current.possibleLocationJson).toBeDefined();
    });

    await waitFor(() => {
      expect(result.current.isLoading.location).toBe(false);
    });
  });
});
