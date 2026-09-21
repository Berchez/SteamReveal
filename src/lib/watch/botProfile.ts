import { isSteamId64 } from '@/lib/steamId';

/**
 * Bot-profile link for user-facing surfaces (waiting room, and previously
 * the navbar sign-in cluster): derived from the same `STEAM_BOT_STEAMID`
 * the login gate checks friendship against, so the link can never point
 * at a different account than the gate. Null on missing/invalid env —
 * callers hide the button and fail closed downstream, so global chrome
 * never breaks over env.
 */
// Named (not default) export on purpose: mirrors steamFriendList.ts
// (same consumer pair imports it by name).
// eslint-disable-next-line import/prefer-default-export
export const resolveBotProfileUrl = (): string | null => {
  const botSteamId = process.env.STEAM_BOT_STEAMID;
  return typeof botSteamId === 'string' && isSteamId64(botSteamId)
    ? `https://steamcommunity.com/profiles/${botSteamId}`
    : null;
};
