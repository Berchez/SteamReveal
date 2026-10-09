import {
  RECONNECT_STEAM_READ_MIN_GAP_MS,
  resetReconnectThrottleForTests,
  shouldThrottleReconnectRead,
} from './reconnectThrottle';

describe('reconnectThrottle', () => {
  beforeEach(() => {
    resetReconnectThrottleForTests();
  });

  it('allows the first read for a viewer', () => {
    expect(shouldThrottleReconnectRead('steam-a', 1_000)).toBe(false);
  });

  it('throttles a repeat read inside the gap', () => {
    expect(shouldThrottleReconnectRead('steam-a', 1_000)).toBe(false);
    expect(
      shouldThrottleReconnectRead('steam-a', 1_000 + RECONNECT_STEAM_READ_MIN_GAP_MS - 1),
    ).toBe(true);
  });

  it('allows a read once the gap has passed', () => {
    expect(shouldThrottleReconnectRead('steam-a', 1_000)).toBe(false);
    expect(
      shouldThrottleReconnectRead('steam-a', 1_000 + RECONNECT_STEAM_READ_MIN_GAP_MS),
    ).toBe(false);
  });

  it('tracks viewers independently', () => {
    expect(shouldThrottleReconnectRead('steam-a', 1_000)).toBe(false);
    expect(shouldThrottleReconnectRead('steam-b', 1_001)).toBe(false);
  });

  it('bounds memory past the viewer cap (stale entries purged, never an error)', () => {
    for (let i = 0; i < 600; i += 1) {
      expect(shouldThrottleReconnectRead(`steam-${i}`, 1_000)).toBe(false);
    }
    // All 600 stamps are stale relative to now: the purge drops them,
    // so a fresh viewer is admitted instead of throwing or growing.
    expect(shouldThrottleReconnectRead('steam-fresh', 1_000_000)).toBe(false);
  });

  it('reset seam clears the timestamps', () => {
    expect(shouldThrottleReconnectRead('steam-a', 1_000)).toBe(false);
    resetReconnectThrottleForTests();
    expect(shouldThrottleReconnectRead('steam-a', 1_001)).toBe(false);
  });
});
