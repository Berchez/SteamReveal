import { useState, useRef } from 'react';
import axios from 'axios';
import targetInfoJsonType from '@/@types/targetInfoJsonType';
import { act, renderHook } from '@testing-library/react';

import { updateCachedSearchById } from '../../shared/cache/homeCache';
import useCheaterProbability from './useCheaterProbability';
import { useRunGuard } from '../run-guard/useRunGuard';

jest.mock('axios');
jest.mock('react-toastify', () => ({ toast: { error: jest.fn() } }));
jest.mock('@vercel/analytics', () => ({ track: jest.fn() }));
jest.mock('../../shared/cache/homeCache', () => ({ updateCachedSearchById: jest.fn() }));

const mockedAxios = axios as jest.Mocked<typeof axios>;

const makeTarget = (steamID: string): targetInfoJsonType =>
  ({ profileInfo: { steamID } }) as targetInfoJsonType;

// Minimal harness reproducing how useHomeSearch feeds useCheaterProbability:
// real useState/useRef, so re-renders behave like the real hook tree.
function useHarness() {
  const runGuard = useRunGuard();
  const [targetInfoJson, setTargetInfoJson] = useState<
    targetInfoJsonType | undefined
  >(undefined);
  const [closeFriendsJson, setCloseFriendsJson] = useState<any>(undefined);
  const [isLoading, setIsLoading] = useState<any>({
    myCard: false,
    friendsCards: false,
    cheaterReport: false,
  });

  const setCheaterDataMockRef = useRef(jest.fn());
  const handleShowSupportMe = jest.fn();
  const lastSearchIdRef = useRef<string | null>(null);

  const { getCheaterProbability } = useCheaterProbability({
    runGuard,
    isLoadingFriendsCards: isLoading.friendsCards,
    setIsLoading,
    targetInfoJson,
    closeFriendsJson,
    setCheaterData: setCheaterDataMockRef.current,
    handleShowSupportMe,
    lastSearchIdRef,
  });

  return {
    getCheaterProbability,
    setTargetInfoJson,
    setCloseFriendsJson,
    reserveNewRun: runGuard.reserveNewRun,
    setCheaterDataMock: setCheaterDataMockRef.current,
  };
}

describe('useCheaterProbability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends the profile that is current at call time, even right after switching profiles', async () => {
    mockedAxios.post.mockResolvedValue({
      data: { cheaterProbability: 0.42, featureObject: {} },
    });

    const { result } = renderHook(() => useHarness());

    // Profile A loads.
    act(() => {
      result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
    });

    // User navigates to profile B — this is what handleGetInfoClick does via
    // reserveNewRun() before the new profile's data is set.
    act(() => {
      result.current.reserveNewRun();
      result.current.setTargetInfoJson(makeTarget('PROFILE_B'));
    });

    // User clicks "cheater report" right after B finishes loading.
    await act(async () => {
      await result.current.getCheaterProbability();
    });

    expect(mockedAxios.post).toHaveBeenCalledWith(
      '/api/getCheaterProbability',
      expect.objectContaining({ target: 'PROFILE_B' }),
    );
  });

  it('does not apply the result to state if the profile changed again while the request was in flight', async () => {
    let resolveRequest: (value: unknown) => void = () => {};
    mockedAxios.post.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveRequest = resolve;
        }),
    );

    const { result } = renderHook(() => useHarness());

    act(() => {
      result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
    });

    const callPromise = act(async () => {
      await result.current.getCheaterProbability();
    });

    // Before the request resolves, user navigates away to profile B.
    act(() => {
      result.current.reserveNewRun();
      result.current.setTargetInfoJson(makeTarget('PROFILE_B'));
    });

    act(() => {
      resolveRequest({
        data: { cheaterProbability: 0.9, featureObject: {} },
      });
    });

    await callPromise;

    expect(result.current.setCheaterDataMock).not.toHaveBeenCalled();
    expect(updateCachedSearchById).not.toHaveBeenCalled();
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
  });
});
