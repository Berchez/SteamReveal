/**
 * Continuous-with-cap discount for how *active* a player is on a platform
 * with a more invasive anti-cheat than Valve's VAC (FACEIT, GamersClub).
 *
 * The rationale: a player who grinds thousands of matches on such a platform
 * is far less likely to be running cheats (the invasive anti-cheat would have
 * caught them), so we shave a little off the cheater probability. This is a
 * dedicated post-model signal — it never enters the ML feature vector (which
 * the model was trained on), just like the platform-ban adjustments.
 *
 * Pure function, no I/O, so it's directly unit-testable.
 */

/**
 * Max probability discount (0.10) applied when a player is heavily active on
 * a platform. Tunable; exposed here so tests and the route share one source
 * of truth.
 */
export const ACTIVITY_REDUCTION_MAX = 0.1;

/**
 * Number of matches at which the discount saturates (reaches its max). Values
 * above this no longer increase the discount — you can't "un-ban" someone, the
 * signal just stops growing once they're clearly a regular.
 */
export const ACTIVITY_SATURATION_MATCHES = 500;

/**
 * Minimum number of matches required before a player counts as "demonstrably
 * active" on the platform at all. Below this there is no discount (the discount
 * curve starts at 0 and rises with matches, so a single match would otherwise
 * yield a tiny but nonzero discount — we explicitly want NO discount — and NO
 * innocence reason — for players with just a match or two).
 */
export const ACTIVITY_MIN_MATCHES = 50;

const clampDiscount = (value: number): number => {
  if (!Number.isFinite(value) || value < 0) return 0;
  return value > ACTIVITY_REDUCTION_MAX ? ACTIVITY_REDUCTION_MAX : value;
};

/**
 * Computes the probability discount owed to platform activity.
 *
 * @param matches - Number of matches (or sessions) the player has on the
 *   platform. `null`/`undefined`/non-finite/negative are treated as "no
 *   data" and yield no discount. Values below `ACTIVITY_MIN_MATCHES` also
 *   yield 0 — you need a real amount of play to count as active.
 * @param bannedForCheat - Whether the player holds a cheating ban on the SAME
 *   platform. "Ban wins": an active cheat ban cancels the activity discount,
 *   otherwise a negative and positive signal from the same source would
 *   partially cancel out a very strong cheating signal.
 */
const activityTier = (
  matches: number | null | undefined,
  bannedForCheat: boolean,
): number => {
  if (bannedForCheat) return 0;
  if (matches === null || matches === undefined || !Number.isFinite(matches)) {
    return 0;
  }
  if (matches < ACTIVITY_MIN_MATCHES) return 0;

  const ratio = Math.min(1, matches / ACTIVITY_SATURATION_MATCHES);
  return clampDiscount(ACTIVITY_REDUCTION_MAX * ratio);
};

export default activityTier;