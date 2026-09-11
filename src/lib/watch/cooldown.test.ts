import isWithinCooldownWindow from './cooldown';

describe('isWithinCooldownWindow', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');

  it('is true inside the window and false at/past the boundary', () => {
    const recent = new Date(now - 23 * 60 * 60 * 1000).toISOString();
    const exactly24h = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const older = new Date(now - 25 * 60 * 60 * 1000).toISOString();

    expect(isWithinCooldownWindow(recent, 24, now)).toBe(true);
    expect(isWithinCooldownWindow(exactly24h, 24, now)).toBe(false);
    expect(isWithinCooldownWindow(older, 24, now)).toBe(false);
  });

  it('fails open on missing or corrupt clocks (never suppresses forever)', () => {
    expect(isWithinCooldownWindow(null, 24, now)).toBe(false);
    expect(isWithinCooldownWindow(undefined, 24, now)).toBe(false);
    expect(isWithinCooldownWindow('garbage', 24, now)).toBe(false);
    expect(isWithinCooldownWindow('', 24, now)).toBe(false);
  });

  it('honors custom windows and explicit timestamps', () => {
    const twoHoursAgo = new Date(now - 2 * 60 * 60 * 1000).toISOString();
    expect(isWithinCooldownWindow(twoHoursAgo, 24, now)).toBe(true);
    expect(isWithinCooldownWindow(twoHoursAgo, 1, now)).toBe(false);
    // Defaults to the real clock when nowMs is omitted.
    expect(
      isWithinCooldownWindow(new Date(Date.now() - 1000).toISOString(), 24),
    ).toBe(true);
  });
});
