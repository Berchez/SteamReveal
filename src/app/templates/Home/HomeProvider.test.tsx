import React, { useState } from 'react';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import HomeProvider from './HomeProvider';
import { HomeActionsContext, HomeDataContext } from './context';
import useHome from './useHome';

// HomeProvider imports useHome with a relative specifier ('./useHome'), so
// the mock path must match exactly for Jest to intercept it.
jest.mock('./useHome');

const mockUseHome = useHome as jest.Mock;

const onChangeTarget = jest.fn();
const onCloseSponsorMe = jest.fn();
const onCloseSupportMe = jest.fn();
const getCheaterProbability = jest.fn();
const navigateToPlayer = jest.fn();
const targetValueRef = { current: null };
// The real useHome hook stores isLoading in useState, so its reference only
// changes when setIsLoading actually runs — not on every unrelated render.
// Keeping this object at module scope (instead of creating a fresh literal
// inside buildHookReturn) reproduces that, otherwise HomeProvider's useMemo
// would legitimately see a "changed" dependency every render and this test
// would be asserting against a broken fixture, not against HomeProvider.
const stableIsLoading = {
  myCard: false,
  friendsCards: false,
  cheaterReport: false,
};

function buildHookReturn() {
  // A brand-new top-level object every call — mirrors what the real useHome
  // hook also does (it returns a fresh object literal every render). This
  // keeps the test honest: it exercises HomeProvider's own useMemo, not
  // whatever memoization useHome itself might happen to provide. Nested
  // values that the real hook keeps referentially stable (isLoading,
  // targetValue) must stay stable here too — see stableIsLoading above.
  return {
    closeFriendsJson: undefined,
    targetValue: targetValueRef,
    possibleLocationJson: undefined,
    targetInfoJson: undefined,
    isLoading: stableIsLoading,
    hasNoDataYet: true,
    showSponsorMe: false,
    cheaterData: undefined,
    showSupportMe: false,
    onChangeTarget,
    onCloseSponsorMe,
    onCloseSupportMe,
    getCheaterProbability,
    navigateToPlayer,
  };
}

// Probe that records the context value reference on every render, so the
// test can compare identities across parent re-renders.
let dataRefs: unknown[] = [];
let actionsRefs: unknown[] = [];

function ContextProbe() {
  const data = React.useContext(HomeDataContext);
  const actions = React.useContext(HomeActionsContext);
  dataRefs.push(data);
  actionsRefs.push(actions);
  return null;
}

function Harness() {
  const [, forceRerender] = useState(0);
  return (
    <HomeProvider>
      <ContextProbe />
      <button type="button" onClick={() => forceRerender((n) => n + 1)}>
        rerender
      </button>
    </HomeProvider>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  dataRefs = [];
  actionsRefs = [];
  mockUseHome.mockImplementation(buildHookReturn);
});

describe('HomeProvider — Case 7: stable context reference identity', () => {
  it('keeps dataValue and actionsValue reference-stable across unrelated re-renders', () => {
    render(<Harness />);

    expect(dataRefs).toHaveLength(1);
    expect(actionsRefs).toHaveLength(1);
    expect(dataRefs[0]).not.toBeNull();
    expect(actionsRefs[0]).not.toBeNull();

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'rerender' }));
    });

    expect(dataRefs).toHaveLength(2);
    expect(actionsRefs).toHaveLength(2);

    // Same underlying primitive/function values every render, so the
    // provider's own useMemo must hand back the exact same object —
    // required for action-only consumers to skip re-renders entirely.
    expect(dataRefs[1]).toBe(dataRefs[0]);
    expect(actionsRefs[1]).toBe(actionsRefs[0]);
  });

  it('produces a new dataValue reference when a data field changes, but keeps actionsValue stable', () => {
    render(<Harness />);
    expect(dataRefs).toHaveLength(1);

    mockUseHome.mockImplementation(() => ({
      ...buildHookReturn(),
      hasNoDataYet: false,
    }));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'rerender' }));
    });

    expect(dataRefs).toHaveLength(2);
    expect(dataRefs[1]).not.toBe(dataRefs[0]);

    // Actions were untouched — their memoized wrapper must remain the same
    // reference even though data changed.
    expect(actionsRefs[1]).toBe(actionsRefs[0]);
  });

  it('produces a new actionsValue reference only when an action reference actually changes', () => {
    render(<Harness />);
    expect(actionsRefs).toHaveLength(1);

    const newNavigateToPlayer = jest.fn();
    mockUseHome.mockImplementation(() => ({
      ...buildHookReturn(),
      navigateToPlayer: newNavigateToPlayer,
    }));

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'rerender' }));
    });

    expect(actionsRefs).toHaveLength(2);
    expect(actionsRefs[1]).not.toBe(actionsRefs[0]);

    // Data was untouched, so dataValue's reference should still be stable.
    expect(dataRefs[1]).toBe(dataRefs[0]);
  });
});
