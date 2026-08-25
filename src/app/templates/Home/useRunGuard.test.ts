import { renderHook, act } from '@testing-library/react';

import { useRunGuard } from './useRunGuard';

describe('useRunGuard', () => {
  it('starts with no active run, so isCurrentRun(null) is true', () => {
    const { result } = renderHook(() => useRunGuard());

    expect(result.current.activeRunRef.current).toBeNull();
    expect(result.current.isCurrentRun(null)).toBe(true);
  });

  it('reserveNewRun returns monotonically increasing ids starting at 1', () => {
    const { result } = renderHook(() => useRunGuard());

    let first = 0;
    let second = 0;
    let third = 0;

    act(() => {
      first = result.current.reserveNewRun();
    });
    act(() => {
      second = result.current.reserveNewRun();
    });
    act(() => {
      third = result.current.reserveNewRun();
    });

    expect([first, second, third]).toEqual([1, 2, 3]);
  });

  it('sets activeRunRef.current to the id it just reserved', () => {
    const { result } = renderHook(() => useRunGuard());

    let id = 0;
    act(() => {
      id = result.current.reserveNewRun();
    });

    expect(result.current.activeRunRef.current).toBe(id);
  });

  it('isCurrentRun reflects only the most recently reserved run', () => {
    const { result } = renderHook(() => useRunGuard());

    let firstId = 0;
    let secondId = 0;

    act(() => {
      firstId = result.current.reserveNewRun();
    });
    expect(result.current.isCurrentRun(firstId)).toBe(true);

    act(() => {
      secondId = result.current.reserveNewRun();
    });

    // The earlier run must now read as stale — this is the guard that
    // getCheaterProbability / getUserInfoJson / getCloseFriendsJson rely on
    // to discard results from a superseded search.
    expect(result.current.isCurrentRun(firstId)).toBe(false);
    expect(result.current.isCurrentRun(secondId)).toBe(true);
  });

  it('once any run has been reserved, isCurrentRun(null) becomes false', () => {
    const { result } = renderHook(() => useRunGuard());

    act(() => {
      result.current.reserveNewRun();
    });

    expect(result.current.isCurrentRun(null)).toBe(false);
  });

  it('keeps reserveNewRun, isCurrentRun and activeRunRef reference-stable across re-renders', () => {
    // Several consumers (useCheaterProbability's useCallback deps,
    // usePlayerUrlSync's navigateToPlayer deps) rely on these staying
    // stable so they don't get recreated on every unrelated render.
    const { result, rerender } = renderHook(() => useRunGuard());

    const { reserveNewRun, isCurrentRun, activeRunRef } = result.current;

    rerender();

    expect(result.current.reserveNewRun).toBe(reserveNewRun);
    expect(result.current.isCurrentRun).toBe(isCurrentRun);
    expect(result.current.activeRunRef).toBe(activeRunRef);
  });
});
