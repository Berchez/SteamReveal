import { isOutOfSpanNumericId } from './steamId';

/**
 * Entry validation for user-supplied search targets (vanity URLs OR
 * SteamID64s), shared by every public route that accepts a target.
 *
 * A 17-digit input that falls OUTSIDE the valid SteamID64 span can never
 * resolve to a real profile (see isPlausibleSteamId64) — reject it here
 * as a 400 instead of letting it burn Steam API calls that only fail with
 * "Bad Request"/"No players found" and surface as 500-shaped incident
 * logs. Vanity names, short numerics and in-range ids are untouched:
 * those remain Steam's resolve() to judge.
 */
export default function isValidTargetParam(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return false;
  }
  // A 17-digit input outside the real span is rejected; everything else
  // (vanity, shorter numbers) is not our call to make — Steam's resolve()
  // judges those.
  if (isOutOfSpanNumericId(value)) {
    return false;
  }
  return true;
}
