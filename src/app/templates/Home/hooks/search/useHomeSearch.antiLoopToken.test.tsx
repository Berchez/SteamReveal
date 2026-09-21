import { renderHook, waitFor } from '@testing-library/react';

import axios from 'axios';

import useHomeSearch from './useHomeSearch';

jest.mock('axios');

const mockedAxios = axios as jest.Mocked<typeof axios>;

// Mutable route param: changing it across rerenders drives a second search
// through the urlPlayer effect, like a real navigation would.
let mockSteamId = 'player-a';
jest.mock('next/navigation', () => ({
  useParams: () => ({ steamId: mockSteamId }),
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
  getCitiesNames: jest.fn(async () => []),
  sortCitiesByScore: jest.fn((scored: Record<string, number>) => scored),
}));

jest.mock('./probabilityMath', () => ({
  computeCloseFriendsProbability: jest.fn((friends: unknown[]) => friends),
  computeCityScores: jest.fn(() => ({})),
  computeLocationProbabilities: jest.fn((cities: unknown[]) => cities),
}));

const { recordAnalytics } = jest.requireMock(
  '../../shared/analytics/homeAnalyticsUtils',
) as { recordAnalytics: jest.Mock };

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

describe('useHomeSearch - anti-loop token sent once', () => {
  beforeEach(() => {
    mockSteamId = 'player-a';
    jest.clearAllMocks();
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getUserInfo') {
        return Promise.resolve({
          data: { targetInfo: { steamID: mockSteamId, nickname: 'x' } },
        });
      }
      if (url === '/api/getCloseFriends') {
        return Promise.resolve({ data: { closeFriends: [] } });
      }
      if (url === '/api/recordAnalyticsFriends') {
        return Promise.resolve({ data: { ok: true, updated: 0 } });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });
  });

  it('attaches the single-use token to the first record only, never to later searches', async () => {
    const runGuard = makeRunGuard();

    const { rerender } = renderHook(() =>
      useHomeSearch({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        runGuard: runGuard as any,
        syncPlayerUrl: jest.fn(),
        consumeSyncedUrlPlayer: jest.fn(() => false),
        clearSyncedUrlPlayer: jest.fn(),
        handleShowSponsorMe: jest.fn(),
        handleShowSupportMe: jest.fn(),
        antiLoopToken: 'tok-123',
      }),
    );

    await waitFor(() => {
      expect(recordAnalytics).toHaveBeenCalledTimes(1);
    });
    expect(recordAnalytics.mock.calls[0][3]).toMatchObject({
      antiLoopToken: 'tok-123',
    });

    // Second search (new navigation): the spent token must not ride along
    // — the backend already consumed it, so resending only burns a no-op
    // UPDATE per search.
    mockSteamId = 'player-b';
    rerender();

    await waitFor(() => {
      expect(recordAnalytics).toHaveBeenCalledTimes(2);
    });
    expect(recordAnalytics.mock.calls[1][3]).toMatchObject({
      antiLoopToken: undefined,
    });
  });
});
