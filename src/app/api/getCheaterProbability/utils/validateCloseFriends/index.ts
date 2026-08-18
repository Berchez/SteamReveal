import { closeFriendsDataIWant } from '@/@types/closeFriendsDataIWant';
import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';

// Re-exported so existing imports (`./utils/validateCloseFriends`) keep
// working unchanged — the actual value now lives in
// @/lib/closeFriendsLimits, shared with GET /api/getCloseFriends.
export { MAX_CLOSE_FRIENDS };

/** Steam64 IDs are always exactly 17 digits (e.g. 76561198146931523). */
const STEAM_ID_64_RE = /^\d{17}$/;

/**
 * Upper bound for `count` (the mutual-friend count computed by
 * GET /api/getCloseFriends and round-tripped back by the client).
 *
 * `count` isn't just cosmetic — calcBansWeight.ts uses it as an
 * exponent multiplier: `3 ** (bansSum * count)`, where bansSum is 0-4.
 * `Number.isFinite` alone does NOT stop this from overflowing: with
 * bansSum = 4 (worst case), `3 ** (4 * count)` exceeds
 * Number.MAX_VALUE (~1.7977e308) and evaluates to `Infinity` once
 * count > ~161 (log3(Number.MAX_VALUE) / 4 ≈ 161.4) — and
 * JSON.stringify silently turns Infinity into `null` on the way to the
 * prediction model (see the comment on calcBansWeight's caller). A
 * single well-formed item with a huge `count` is therefore enough to
 * corrupt the feature vector, independent of the closeFriends array
 * length cap.
 *
 * The realistic maximum `count` this codebase can ever legitimately
 * produce is 100: GET /api/getCloseFriends slices the target's own
 * friend list to at most 100 entries (`friendsOfTheTarget`) before
 * computing mutual-friend counts, and `count` for a given friend can be
 * at most 1 per one of those up-to-100 source friends (see
 * getCloseFriends/route.ts's `getFriendsOfFriends` + the `.filter(...).length`
 * that derives `count`) — so count cannot structurally exceed 100.
 *
 * 120 sits comfortably above that real maximum (no legitimate value is
 * ever rejected) and comfortably below the ~161 overflow threshold
 * (worst case: 3 ** (4 * 120) = 3 ** 480, still far inside double
 * range).
 */
const MAX_FRIEND_COUNT = 120;

/** Keep response payloads (bannedFriendsDetails) bounded; nicknames are
 * real Steam display names, not free-form text, so this is generous. */
const MAX_NICKNAME_LENGTH = 256;

/**
 * Minimal structural check for a single closeFriends[] item — just
 * enough to guarantee it's safe to hand to:
 *  - getBannedFriendsScore(), which reads friend.steamID (must be a real
 *    Steam64 id string — it gets sent straight to steam.getUserBans())
 *    and, if a ban is found, friendData.friend.nickname.
 *  - calcBansWeight(), which reads count as an exponent multiplier —
 *    NaN/Infinity/negative/oversized would produce a garbage (or
 *    Infinity, which JSON.stringify silently turns into `null`) feature
 *    value sent to the prediction model.
 *
 * Deliberately does NOT validate the rest of UserSummary (avatar, level,
 * personaname, etc.) — nothing downstream in this endpoint reads those
 * fields, so validating them would be dead weight. It also does NOT
 * confirm the item is actually a friend of `target` — the ticket calls
 * that out explicitly as a separate, future improvement (the server
 * recomputing the close-friends list itself instead of trusting the
 * client's round-tripped copy); the size cap + shape check here close
 * off the most direct abuse vectors without requiring that larger
 * change.
 */
export const isValidCloseFriendItem = (
  item: unknown,
): item is closeFriendsDataIWant => {
  if (typeof item !== 'object' || item === null) {
    return false;
  }

  const { friend, count } = item as Record<string, unknown>;

  if (typeof friend !== 'object' || friend === null) {
    return false;
  }

  const { steamID, nickname } = friend as Record<string, unknown>;
  if (typeof steamID !== 'string' || !STEAM_ID_64_RE.test(steamID)) {
    return false;
  }

  if (
    nickname !== undefined &&
    (typeof nickname !== 'string' || nickname.length > MAX_NICKNAME_LENGTH)
  ) {
    return false;
  }

  if (
    typeof count !== 'number' ||
    !Number.isFinite(count) ||
    count < 0 ||
    count > MAX_FRIEND_COUNT
  ) {
    return false;
  }

  return true;
};
