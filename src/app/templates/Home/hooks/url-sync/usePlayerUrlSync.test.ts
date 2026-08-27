import { renderHook, act } from '@testing-library/react';
import { useSearchParams } from 'next/navigation';

import usePlayerUrlSync from './usePlayerUrlSync';

jest.mock('next/navigation', () => ({
  useSearchParams: jest.fn(),
}));

// IMPORTANT: mocking '@/navigation' directly does NOT intercept the real
// import inside usePlayerUrlSync.ts — the alias gets rewritten to its real
// resolved path before Jest ever sees the alias string. Mocking the
// underlying 'next-intl/navigation' package (same approach already used in
// useHome.riskScenarios.test.tsx) guarantees interception regardless of
// where '@/navigation.ts' lives.
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

// Controlled fixture instead of the project's real navigationParams list,
// so this test doesn't silently drift if that list changes for unrelated
// reasons — only the "strip owned params" *behavior* is under test here.
jest.mock('./navigationParams', () => ({
  __esModule: true,
  default: ['ownedParam'],
}));

const mockUseSearchParams = useSearchParams as jest.Mock;

describe('usePlayerUrlSync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseSearchParams.mockReturnValue(new URLSearchParams());
  });

  describe('buildPlayerHref (exercised via navigateToPlayer)', () => {
    it('builds a plain player path when there are no extra query params', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.navigateToPlayer('76500000000000001');
      });

      expect(mockRouterPush).toHaveBeenCalledWith('/player/76500000000000001', {
        scroll: false,
      });
    });

    it('URL-encodes the steamId', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.navigateToPlayer('some id/weird');
      });

      expect(mockRouterPush).toHaveBeenCalledWith(
        `/player/${encodeURIComponent('some id/weird')}`,
        { scroll: false },
      );
    });

    it('preserves non-owned query params (utm tags, referral, feature flags)', () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams('utm_source=twitter&ref=abc'),
      );
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.navigateToPlayer('123');
      });

      const [href] = mockRouterPush.mock.calls[0];
      expect(href).toContain('/player/123?');
      expect(href).toContain('utm_source=twitter');
      expect(href).toContain('ref=abc');
    });

    it('strips NAVIGATION_OWNED_PARAMS before building the href', () => {
      mockUseSearchParams.mockReturnValue(
        new URLSearchParams('ownedParam=shouldBeDropped&keep=me'),
      );
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.navigateToPlayer('123');
      });

      const [href] = mockRouterPush.mock.calls[0];
      expect(href).not.toContain('ownedParam');
      expect(href).toContain('keep=me');
    });
  });

  describe('navigateToPlayer', () => {
    it('reserves a new run BEFORE pushing, so a slower in-flight search cannot win the race', () => {
      const callOrder: string[] = [];
      const reserveNewRun = jest.fn(() => {
        callOrder.push('reserveNewRun');
        return 1;
      });
      mockRouterPush.mockImplementation(() => {
        callOrder.push('push');
      });

      const { result } = renderHook(() => usePlayerUrlSync(reserveNewRun));

      act(() => {
        result.current.navigateToPlayer('123');
      });

      expect(callOrder).toEqual(['reserveNewRun', 'push']);
    });

    it('pushes (creates a history entry), never replaces', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.navigateToPlayer('123');
      });

      expect(mockRouterPush).toHaveBeenCalledTimes(1);
      expect(mockRouterReplace).not.toHaveBeenCalled();
    });
  });

  describe('syncPlayerUrl / consumeSyncedUrlPlayer / clearSyncedUrlPlayer', () => {
    it('syncPlayerUrl replaces (does not push / does not create history)', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.syncPlayerUrl('resolved-id');
      });

      expect(mockRouterReplace).toHaveBeenCalledWith('/player/resolved-id', {
        scroll: false,
      });
      expect(mockRouterPush).not.toHaveBeenCalled();
    });

    it('consumeSyncedUrlPlayer returns true for a matching id and consumes the marker', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.syncPlayerUrl('resolved-id');
      });

      let first = false;
      let second = false;

      act(() => {
        first = result.current.consumeSyncedUrlPlayer('resolved-id');
      });
      act(() => {
        // The marker was consumed above — checking the same id again must
        // NOT still return true (otherwise every future navigation to this
        // id would be silently treated as "already handled").
        second = result.current.consumeSyncedUrlPlayer('resolved-id');
      });

      expect(first).toBe(true);
      expect(second).toBe(false);
    });

    it('consumeSyncedUrlPlayer returns false for an id that was never internally synced', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      let matched = true;
      act(() => {
        matched = result.current.consumeSyncedUrlPlayer('never-synced');
      });

      expect(matched).toBe(false);
    });

    it('consumeSyncedUrlPlayer(undefined) does not match a pending sync', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.syncPlayerUrl('resolved-id');
      });

      let matched = true;
      act(() => {
        matched = result.current.consumeSyncedUrlPlayer(undefined);
      });

      expect(matched).toBe(false);
    });

    it('clearSyncedUrlPlayer discards a pending sync so it is no longer consumable', () => {
      const { result } = renderHook(() => usePlayerUrlSync(jest.fn(() => 1)));

      act(() => {
        result.current.syncPlayerUrl('resolved-id');
        result.current.clearSyncedUrlPlayer();
      });

      let matched = true;
      act(() => {
        matched = result.current.consumeSyncedUrlPlayer('resolved-id');
      });

      expect(matched).toBe(false);
    });
  });
});
