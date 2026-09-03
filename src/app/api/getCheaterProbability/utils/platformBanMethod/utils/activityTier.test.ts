import activityTier, {
  ACTIVITY_MIN_MATCHES,
  ACTIVITY_REDUCTION_MAX,
  ACTIVITY_SATURATION_MATCHES,
} from './activityTier';

describe('activityTier', () => {
  it('returns 0 for null/undefined/invalid matches', () => {
    expect(activityTier(null, false)).toBe(0);
    expect(activityTier(undefined, false)).toBe(0);
    expect(activityTier(Number.NaN, false)).toBe(0);
    expect(activityTier(Number.POSITIVE_INFINITY, false)).toBe(0);
    expect(activityTier(-5, false)).toBe(0);
  });

  it('returns 0 for zero or missing activity', () => {
    expect(activityTier(0, false)).toBe(0);
  });

  it('returns 0 below the minimum-match threshold (not enough to call them active)', () => {
    expect(activityTier(1, false)).toBe(0);
    expect(activityTier(10, false)).toBe(0);
    expect(activityTier(ACTIVITY_MIN_MATCHES - 1, false)).toBe(0);
  });

  it('starts to discount exactly at the minimum-match threshold', () => {
    // 50 / 500 = 0.1 * 0.1 = 0.01
    expect(activityTier(ACTIVITY_MIN_MATCHES, false)).toBeCloseTo(0.01, 10);
  });

  it('returns the full max at/above the saturation point', () => {
    expect(activityTier(ACTIVITY_SATURATION_MATCHES, false)).toBe(
      ACTIVITY_REDUCTION_MAX,
    );
    expect(activityTier(1000, false)).toBe(ACTIVITY_REDUCTION_MAX);
  });

  it('scales linearly below the saturation point', () => {
    // 100 / 500 = 0.2 * 0.1 = 0.02
    expect(activityTier(100, false)).toBeCloseTo(0.02, 10);
    // 250 / 500 = 0.5 * 0.1 = 0.05
    expect(activityTier(250, false)).toBeCloseTo(0.05, 10);
  });

  it('gives 0 discount when the player is banned for cheating on that platform', () => {
    expect(activityTier(ACTIVITY_SATURATION_MATCHES, true)).toBe(0);
    expect(activityTier(5000, true)).toBe(0);
    // Even with huge activity, the cheat ban still wins.
    expect(activityTier(9999, true)).toBe(0);
  });

  it('does not treat a non-cheat ban as cancelling the discount', () => {
    // bannedForCheat=false (e.g. an "other"/smurf ban) should NOT kill the
    // activity discount — only an active cheating ban does.
    expect(activityTier(ACTIVITY_SATURATION_MATCHES, false)).toBe(
      ACTIVITY_REDUCTION_MAX,
    );
  });
});