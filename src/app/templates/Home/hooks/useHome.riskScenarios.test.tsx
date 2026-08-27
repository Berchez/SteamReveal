import { act, renderHook, waitFor } from '@testing-library/react';
import axios from 'axios';
import { toast } from 'react-toastify';
import { useParams, useSearchParams } from 'next/navigation';
import useSponsorMe from '@/app/components/SponsorMe/useSponsorMe';
import useSupportMe from '@/app/components/SupportMe/useSupportMe';
import {
  getCitiesNames,
  getLocationDetails,
  sortCitiesByScore,
} from './search/homeUtils';
import { getCachedSearch, setCachedSearch } from '../shared/cache/homeCache';
import useHome from './useHome';

// ===========================================================================
// useHome — hook-level behavioral risk scenarios (Cases 1-4).
// These need a much heavier mock stack than the helper above, so they're
// scoped inside their own describe block with dedicated module mocks and
// beforeEach — kept in this file (rather than a parallel one) since it's
// already the designated test file for useHome.ts.
// ===========================================================================

jest.mock('axios');

jest.mock('react-toastify', () => ({
  toast: { error: jest.fn(), success: jest.fn() },
}));

jest.mock('next-intl', () => ({
  useLocale: () => 'en',
  useTranslations: () => (key: string) => key,
}));

jest.mock('next/navigation', () => ({
  useParams: jest.fn(),
  useSearchParams: jest.fn(),
}));

// IMPORTANT: mocking '@/navigation' directly does NOT intercept the real
// import inside useHome.ts in this project — the alias gets rewritten to
// its real resolved path before Jest ever sees the alias string. `@/navigation.ts`
// itself is built on top of next-intl's `createNavigation` (from the plain,
// unaliased `next-intl/navigation` package) — mocking that package instead
// guarantees interception regardless of where `@/navigation.ts` lives.
//
// Note the `mock` prefix on the router fns: babel-plugin-jest-hoist moves
// jest.mock() calls above all other statements in the file, and only
// allows referencing outer identifiers whose name starts with "mock"
// inside the factory — anything else throws a
// "reference before initialization" error.
const mockRouterPush = jest.fn();
const mockRouterReplace = jest.fn();

jest.mock('next-intl/navigation', () => ({
  createNavigation: () => ({
    Link: () => null,
    redirect: jest.fn(),
    usePathname: jest.fn(),
    useRouter: () => ({ push: mockRouterPush, replace: mockRouterReplace }),
    getPathname: jest.fn(),
  }),
}));

jest.mock('../../../components/SponsorMe/useSponsorMe', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../../../components/SupportMe/useSupportMe', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@vercel/analytics', () => ({
  track: jest.fn(),
}));

jest.mock('./search/homeUtils', () => ({
  getLocationDetails: jest.fn(),
  getCitiesNames: jest.fn(),
  sortCitiesByScore: jest.fn(),
}));

jest.mock('../shared/cache/homeCache', () => ({
  getCachedSearch: jest.fn(),
  setCachedSearch: jest.fn(),
  updateCachedSearchById: jest.fn(),
}));

const mockedAxios = axios as jest.Mocked<typeof axios>;
const mockUseParams = useParams as jest.Mock;
const mockUseSearchParams = useSearchParams as jest.Mock;
const mockUseSponsorMe = useSponsorMe as jest.Mock;
const mockUseSupportMe = useSupportMe as jest.Mock;
const mockGetLocationDetails = getLocationDetails as jest.Mock;
const mockGetCitiesNames = getCitiesNames as jest.Mock;
const mockSortCitiesByScore = sortCitiesByScore as jest.Mock;
const mockGetCachedSearch = getCachedSearch as jest.Mock;
const mockSetCachedSearch = setCachedSearch as jest.Mock;

const handleShowSponsorMe = jest.fn();
const onCloseSponsorMe = jest.fn();
const handleShowSupportMe = jest.fn();
const onCloseSupportMe = jest.fn();

function makeTargetInfo(steamID: string) {
  return {
    steamID,
    nickname: `nick-${steamID}`,
    avatar: { small: '', medium: '', large: '', hash: '' },
    countryCode: undefined,
    stateCode: undefined,
    cityID: undefined,
    url: `https://steamcommunity.com/id/${steamID}`,
  };
}

function makeCloseFriends(prefix = 'friend') {
  // getCloseFriendsCore reads closeFriends[0..4].count unconditionally,
  // so every fixture needs at least 5 entries.
  return Array.from({ length: 5 }).map((_, i) => ({
    friend: makeTargetInfo(`${prefix}-${i}`),
    count: 10 + i,
  }));
}

function defaultAxiosPostImpl(url: string, body?: any) {
  switch (url) {
    case '/api/getUserInfo':
      return Promise.resolve({
        data: { targetInfo: makeTargetInfo(body?.target) },
      });
    case '/api/getCloseFriends':
      return Promise.resolve({ data: { closeFriends: makeCloseFriends() } });
    case '/api/getGamersClubName':
      return Promise.resolve({ data: { gcName: null } });
    case '/api/recordAnalytics':
      return Promise.resolve({ data: { id: 'analytics-id' } });
    case '/api/getCheaterProbability':
      return Promise.resolve({
        data: { cheaterProbability: 10, featureObject: {} },
      });
    default:
      return Promise.resolve({ data: {} });
  }
}

describe('useHome — behavioral risk scenarios', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    mockUseSearchParams.mockReturnValue(new URLSearchParams());

    mockUseSponsorMe.mockReturnValue({
      showSponsorMe: false,
      handleShowSponsorMe,
      onCloseSponsorMe,
    });

    mockUseSupportMe.mockReturnValue({
      showSupportMe: false,
      handleShowSupportMe,
      onCloseSupportMe,
    });

    mockGetLocationDetails.mockResolvedValue({
      country: undefined,
      state: undefined,
      city: undefined,
    });

    mockSortCitiesByScore.mockImplementation((input) => input);
    mockGetCitiesNames.mockResolvedValue([]);

    mockGetCachedSearch.mockReturnValue(undefined);

    (mockedAxios.post as jest.Mock).mockImplementation(defaultAxiosPostImpl);
  });

  // -------------------------------------------------------------------
  // Case 1 — cache hit skips network requests
  // -------------------------------------------------------------------
  describe('Case 1: cache hit avoids network requests', () => {
    it('restores state from cache and skips getUserInfo/getCloseFriends/getCheaterProbability', async () => {
      const cachedRecord = {
        targetInfoJson: {
          profileInfo: makeTargetInfo('resolved-cached-id'),
          targetLocationInfo: {
            country: undefined,
            state: undefined,
            city: undefined,
          },
        },
        closeFriendsJson: makeCloseFriends('cached-friend'),
        possibleLocationJson: [],
        cheaterData: undefined,
        searchId: 'cached-search-id',
      };

      mockUseParams.mockReturnValue({ steamId: 'cached123' });
      mockGetCachedSearch.mockReturnValue(cachedRecord);

      const { result } = renderHook(() => useHome());

      await waitFor(() => {
        expect(result.current.targetInfoJson).toEqual(
          cachedRecord.targetInfoJson,
        );
      });

      expect(result.current.closeFriendsJson).toEqual(
        cachedRecord.closeFriendsJson,
      );
      expect(result.current.possibleLocationJson).toEqual(
        cachedRecord.possibleLocationJson,
      );
      expect(result.current.cheaterData).toEqual(cachedRecord.cheaterData);

      expect(handleShowSponsorMe).toHaveBeenCalledTimes(1);
      expect(handleShowSupportMe).toHaveBeenCalledWith(1);

      // Cached profile resolved to an id different from the current URL
      // param — the hook must silently sync the URL via router.replace.
      expect(mockRouterReplace).toHaveBeenCalledWith(
        expect.stringContaining('/player/resolved-cached-id'),
        { scroll: false },
      );

      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getUserInfo',
        expect.anything(),
      );
      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCloseFriends',
        expect.anything(),
      );
      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.anything(),
      );
    });
  });

  // -------------------------------------------------------------------
  // Case 2 — resilient caching on partial failure
  // -------------------------------------------------------------------
  describe('Case 2: resilient caching on partial failure', () => {
    it('still caches the search when getPossibleLocation fails after profile+friends succeed', async () => {
      mockUseParams.mockReturnValue({ steamId: 'fresh-id' });
      mockGetCachedSearch.mockReturnValue(undefined);

      // Rejecting getCitiesNames makes getPossibleLocation throw internally.
      mockGetCitiesNames.mockRejectedValue(new Error('location service down'));

      renderHook(() => useHome());

      await waitFor(() => {
        expect(mockSetCachedSearch).toHaveBeenCalled();
      });

      const [searchedValue, resolvedSteamId, cachedPayload] =
        mockSetCachedSearch.mock.calls[0];

      expect(searchedValue).toBe('fresh-id');
      expect(resolvedSteamId).toBe('fresh-id');
      expect(cachedPayload.targetInfoJson.profileInfo.steamID).toBe('fresh-id');
      expect(cachedPayload.closeFriendsJson).toHaveLength(5);
      // Location resolution failed — falls back to an empty array instead
      // of discarding the already-resolved profile/friends data.
      expect(cachedPayload.possibleLocationJson).toEqual([]);

      expect(toast.error).toHaveBeenCalledWith('invalidPlayer');

      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/getUserInfo',
        expect.objectContaining({ target: 'fresh-id' }),
      );
      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/getCloseFriends',
        expect.objectContaining({ target: 'fresh-id' }),
      );
    });
  });

  // -------------------------------------------------------------------
  // Case 3 — race condition mitigation
  // -------------------------------------------------------------------
  describe('Case 3: race condition mitigation', () => {
    it('ignores a stale response from a search superseded by a newer one', async () => {
      let currentSteamId: string | undefined = '111';
      mockUseParams.mockImplementation(() => ({ steamId: currentSteamId }));
      mockGetCachedSearch.mockReturnValue(undefined);

      const deferred: Record<
        string,
        { promise: Promise<any>; resolve: (v: any) => void }
      > = {};

      const createDeferred = (target: string) => {
        let resolveFn: (v: any) => void = () => {};
        const promise = new Promise((resolve) => {
          resolveFn = resolve;
        });
        deferred[target] = { promise, resolve: resolveFn };
        return deferred[target];
      };

      (mockedAxios.post as jest.Mock).mockImplementation(
        (url: string, body?: any) => {
          if (url === '/api/getUserInfo') {
            const target = body.target;
            const entry = deferred[target] ?? createDeferred(target);
            return entry.promise;
          }
          return defaultAxiosPostImpl(url, body);
        },
      );

      const { result, rerender } = renderHook(() => useHome());

      // Search A ("111") starts and is left pending on /api/getUserInfo.
      await waitFor(() => {
        expect(deferred['111']).toBeDefined();
      });

      // Search B ("222") starts before A has resolved.
      currentSteamId = '222';
      rerender();

      await waitFor(() => {
        expect(deferred['222']).toBeDefined();
      });

      // B resolves first and completes the full flow.
      await act(async () => {
        deferred['222'].resolve({
          data: { targetInfo: makeTargetInfo('222') },
        });
      });

      await waitFor(() => {
        expect(result.current.targetInfoJson?.profileInfo.steamID).toBe('222');
      });

      // A resolves late — its result must be discarded entirely, not
      // applied on top of B's already-displayed data.
      await act(async () => {
        deferred['111'].resolve({
          data: { targetInfo: makeTargetInfo('111') },
        });
        await Promise.resolve();
      });

      expect(result.current.targetInfoJson?.profileInfo.steamID).toBe('222');
    });
  });

  // -------------------------------------------------------------------
  // Case 4 — navigating back to home resets state
  // -------------------------------------------------------------------
  describe('Case 4: navigating back to home resets state', () => {
    it('clears all derived state once urlPlayer becomes undefined', async () => {
      const cachedRecord = {
        targetInfoJson: {
          profileInfo: makeTargetInfo('existing'),
          targetLocationInfo: {
            country: undefined,
            state: undefined,
            city: undefined,
          },
        },
        closeFriendsJson: makeCloseFriends(),
        possibleLocationJson: [{ location: {}, count: 1, probability: 10 }],
        cheaterData: { cheaterProbability: 42, featureObject: {} } as any,
        searchId: 'search-1',
      };

      let currentSteamId: string | undefined = 'existing';
      mockUseParams.mockImplementation(() => ({ steamId: currentSteamId }));
      mockGetCachedSearch.mockImplementation((value: string) =>
        value === 'existing' ? cachedRecord : undefined,
      );

      const { result, rerender } = renderHook(() => useHome());

      await waitFor(() => {
        expect(result.current.targetInfoJson).toEqual(
          cachedRecord.targetInfoJson,
        );
      });
      expect(result.current.hasNoDataYet).toBe(false);

      currentSteamId = undefined;
      rerender();

      await waitFor(() => {
        expect(result.current.hasNoDataYet).toBe(true);
      });

      expect(result.current.targetInfoJson).toBeUndefined();
      expect(result.current.closeFriendsJson).toBeUndefined();
      expect(result.current.possibleLocationJson).toBeUndefined();
      expect(result.current.cheaterData).toBeUndefined();
    });
  });
});
