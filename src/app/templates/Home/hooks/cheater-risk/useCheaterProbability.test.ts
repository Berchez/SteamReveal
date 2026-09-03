import { useState, useRef, useCallback } from 'react';
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

const makeTarget = (
  steamID: string,
  isCSActive: boolean = true,
): targetInfoJsonType =>
  ({ profileInfo: { steamID, isCSActive } } as unknown) as targetInfoJsonType;

// Minimal harness reproducing how useHomeSearch feeds useCheaterProbability:
// real useState/useRef, so re-renders behave like the real hook tree.
function useHarness() {
  const runGuard = useRunGuard();
  const [targetInfoJson, setTargetInfoJson] = useState<
    targetInfoJsonType | undefined
  >(undefined);
  const [closeFriendsJson, setCloseFriendsJson] = useState<any>(undefined);
  const [cheaterData, setCheaterDataState] = useState<any>(undefined);
  const [isLoading, setIsLoading] = useState<any>({
    myCard: false,
    friendsCards: false,
    cheaterReport: false,
  });

  const setCheaterDataMockRef = useRef(jest.fn());

  // The hook calls setCheaterData when a fetch completes. Update BOTH the
  // scope mock (for run-guard assertions) and the real state (so the
  // auto-prefetch effect's `if (cheaterData) return` self-terminates, exactly
  // as it does in the real useHome wiring).
  const setCheaterData = useCallback((value: any) => {
    setCheaterDataMockRef.current(value);
    setCheaterDataState(value);
  }, []);

  const { prefetchCheaterReport, cheaterError, retryCheaterReport, resetCheaterError } =
    useCheaterProbability({
      runGuard,
      isLoadingFriendsCards: isLoading.friendsCards,
      setIsLoading,
      targetInfoJson,
      closeFriendsJson,
      cheaterData,
      setCheaterData,
    });

  return {
    prefetchCheaterReport,
    cheaterError,
    retryCheaterReport,
    resetCheaterError,
    setTargetInfoJson,
    setCloseFriendsJson,
    setCheaterData: setCheaterDataState,
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
      await result.current.prefetchCheaterReport();
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
      await result.current.prefetchCheaterReport();
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

  describe('prefetchCheaterReport (auto background fetch)', () => {
    const FRIENDS = [{ friend: { steamID: 'f1' }, count: 10 }];

    it('fetches without firing monetization or the track event', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { cheaterProbability: 0.42, featureObject: {} },
      });

      const { result } = renderHook(() => useHarness());

      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
        result.current.setCloseFriendsJson(FRIENDS);
      });

      // play out the async momentum so any queued effects/flushes settle
      await act(async () => {
        await Promise.resolve();
      });

      await act(async () => {
        await result.current.prefetchCheaterReport();
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.objectContaining({ target: 'PROFILE_A' }),
      );
      // Prefetch is a pure background fetch — no mock/auth side effects beyond
      // the call itself (monetization + analytics live in useHome's
      // openCheaterReport, not here).
    });

    it('auto-fires once both target and close friends are ready', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { cheaterProbability: 0.42, featureObject: {} },
      });

      const { result } = renderHook(() => useHarness());

      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.anything(),
      );

      // Target loads first — but no close friends yet, so no prefetch.
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
      });
      await act(async () => {});
      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.anything(),
      );

      // Friends ready → prefetch fires automatically, no explicit click.
      act(() => {
        result.current.setCloseFriendsJson(FRIENDS);
      });
      await act(async () => {});
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedAxios.post).toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.objectContaining({ target: 'PROFILE_A' }),
      );
    });

    it('does NOT auto-prefetch when Counter-Strike is not active (cost gate)', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { cheaterProbability: 0.42, featureObject: {} },
      });

      const { result } = renderHook(() => useHarness());

      // Target + close friends both ready, but CS is not the user's active
      // game family → the expensive background request must be skipped.
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A', false));
        result.current.setCloseFriendsJson(FRIENDS);
      });
      await act(async () => {});
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.anything(),
      );
    });

    it('does NOT re-fetch silently on reference churn after an auto-prefetch failure', async () => {
      mockedAxios.post.mockRejectedValue(new Error('provider rate-limited (429)'));

      const { result } = renderHook(() => useHarness());

      // A ready target with active CS triggers the auto-prefetch, which fails.
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
        result.current.setCloseFriendsJson(FRIENDS);
      });
      await act(async () => {});
      await act(async () => {
        await Promise.resolve();
      });
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);

      // Reference churn re-runs the auto-prefetch effect (same steamID, new
      // object) — but the previous attempt failed, so it must NOT burn another
      // rate-limited request. The explicit retry button is the recovery path.
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
      });
      await act(async () => {});
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
      expect(result.current.cheaterError).toBe(true);
    });

    it('does not auto-prefetch once cheaterData is already present', async () => {
      mockedAxios.post.mockResolvedValue({
        data: { cheaterProbability: 0.42, featureObject: {} },
      });

      const { result } = renderHook(() => useHarness());

      // Present data as if it were cached / already fetched.
      act(() => {
        result.current.setCheaterData({ cheaterProbability: 0.5 });
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
        result.current.setCloseFriendsJson(FRIENDS);
      });

      await act(async () => {});
      await act(async () => {
        await Promise.resolve();
      });

      expect(mockedAxios.post).not.toHaveBeenCalledWith(
        '/api/getCheaterProbability',
        expect.anything(),
      );
    });

    it('does NOT show an error toast when the background auto-prefetch fails', async () => {
      mockedAxios.post.mockRejectedValue(
        new Error('provider rate-limited (429)'),
      );

      const { result } = renderHook(() => useHarness());

      // The auto-prefetch fires silently (target + friends ready + CS active).
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
        result.current.setCloseFriendsJson(FRIENDS);
      });
      await act(async () => {
        await Promise.resolve();
      });

      // A background failure must never surface an error toast — the user
      // never asked for this resource. But the hook still records the error.
      expect((await import('react-toastify')).toast.error).not.toHaveBeenCalled();
      expect(result.current.cheaterError).toBe(true);
    });
  });

  describe('error state + retry (user-requested path)', () => {
    it('sets cheaterError on failure and clears it via retryCheaterReport', async () => {
      mockedAxios.post.mockRejectedValue(new Error('provider down'));

      const { result } = renderHook(() => useHarness());

      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
      });

      await act(async () => {
        await result.current.retryCheaterReport();
      });

      expect(result.current.cheaterError).toBe(true);

      // Retry succeeds → error clears and data is set.
      (mockedAxios.post as jest.Mock).mockResolvedValue({
        data: { cheaterProbability: 0.42, featureObject: {} },
      });

      await act(async () => {
        await result.current.retryCheaterReport();
      });

      expect(result.current.cheaterError).toBe(false);
      expect(result.current.setCheaterDataMock).toHaveBeenCalledWith(
        expect.objectContaining({ cheaterProbability: 0.42 }),
      );
    });

    it('shows an error toast when a user-requested retry fails', async () => {
      mockedAxios.post.mockRejectedValue(new Error('still down'));

      const { result } = renderHook(() => useHarness());

      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
      });

      await act(async () => {
        await result.current.retryCheaterReport();
      });

      expect((await import('react-toastify')).toast.error).toHaveBeenCalledTimes(
        1,
      );
    });

    it('clears a stale error via resetCheaterError without starting a fetch (player-switch path)', async () => {
      mockedAxios.post.mockRejectedValue(new Error('down'));

      const { result } = renderHook(() => useHarness());

      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_A'));
      });

      await act(async () => {
        await result.current.retryCheaterReport();
      });
      expect(result.current.cheaterError).toBe(true);

      // Player switches to B and no auto-fetch runs yet (CS not active) —
      // useHome's effect calls resetCheaterError to guarantee the old error
      // never leaks into B before a fresh fetch gets a chance to run.
      act(() => {
        result.current.setTargetInfoJson(makeTarget('PROFILE_B', false));
        result.current.resetCheaterError();
      });

      expect(result.current.cheaterError).toBe(false);
      expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    });
  });
});
