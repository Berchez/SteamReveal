import { isSteamId64 } from './steamId';

/**
 * Bot-friendship check (single-state model: login requires the user to
 * already have the bot as a friend).
 *
 * Reads the BOT's friend list via ISteamUser/GetFriendList and reports
 * whether `userSteamId` is on it. The bot side is queried (not the
 * user's list) so a private user profile can still log in — but the
 * bot's own friends list must stay PUBLIC (ops requirement, see
 * WATCH_BOT_RUNBOOK.md), otherwise every check degrades to unknown.
 *
 * Tri-state by design, never throws: `true` = friends (login may
 * proceed), `false` = definitively not friends (login-first flow holds
 * the verified identity in the waiting room), `null` = could not
 * determine (private list, bad key, transport error — the caller fails
 * with the generic error path, same fail-closed posture as a missing
 * SESSION_SECRET).
 * Mirror of steamPlayerSummary.ts conventions: dependency-free relative
 * import, plain fetch both runtimes can use (Next route + ts-node bot),
 * no caching/timeout inside (callers own those policies).
 */
/**
 * Shared bound for the friendship check, owned HERE (next to the call it
 * bounds) and imported by both login paths: a hung GetFriendList must fail
 * visibly — fail-closed in the callback, fail-wait in the pending route —
 * never wedge for the default fetch timeout. Same accepted limitation as
 * everywhere withTimeout is used: the underlying request is not aborted,
 * only our wait for it.
 */
export const BOT_FRIENDSHIP_TIMEOUT_MS = 8000;

// Named (not default) export on purpose: mirrors steamPlayerSummary.ts
// (same consumer pair imports it by name).
// eslint-disable-next-line import/prefer-default-export
export const isBotFriend = async (
  apiKey: string,
  botSteamId: string,
  userSteamId: string,
): Promise<boolean | null> => {
  if (
    !isSteamId64(botSteamId) ||
    !isSteamId64(userSteamId) ||
    apiKey === ''
  ) {
    return null;
  }
  try {
    const res = await fetch(
      `https://api.steampowered.com/ISteamUser/GetFriendList/v0001/?key=${encodeURIComponent(apiKey)}&steamid=${botSteamId}&relationship=friend`,
      // Next-only option, ignored by Node: friendship data must never
      // come from a cached CDN/proxy response either way.
      { cache: 'no-store' },
    );
    if (!res.ok) return null;
    // Shape verified LIVE (2026-09: raw dump against the real endpoint):
    // GetFriendList returns `friendslist` at the TOP level, NOT wrapped in
    // `response` like most Steam Web API methods. Parsing `response.*`
    // here silently degrades EVERY login to unknown (fail-closed) while
    // the list is actually fine — that exact bug shipped once because the
    // unit mocks mirrored the code instead of the wire. The wrapped shape
    // stays as a defensive fallback only.
    const body = (await res.json()) as {
      friendslist?: { friends?: Array<{ steamid?: unknown }> };
      response?: { friendslist?: { friends?: Array<{ steamid?: unknown }> } };
    };
    const friends =
      body?.friendslist?.friends ?? body?.response?.friendslist?.friends;
    if (!Array.isArray(friends)) return null;
    return friends.some(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        String(entry.steamid) === userSteamId,
    );
  } catch {
    return null;
  }
};
