/**
 * Ban Reveal alert message — sent over Steam chat when a reviewed profile
 * transitions from not-banned to banned.
 *
 * Templates live in @/lib/watch/notificationText (shared base): the copy
 * is deliberately GENERIC (never names the profile — the subscriber learns
 * which only via the inbox reveal click), keyed by the subscriber's stored
 * locale. Keep every template free of `[` characters: steam-user escapes
 * them as BBCode and they would render mangled.
 */

import {
  DEFAULT_WATCH_LOCALE,
  getBanAlertText,
} from '../lib/watch/notificationText';

export const DEFAULT_BAN_ALERT_LOCALE = DEFAULT_WATCH_LOCALE;

/** Resolves the generic alert text for a subscriber locale. */
export const getBanAlertMessage = (
  locale: string | null | undefined,
): string => getBanAlertText(locale);

/**
 * Minimal structural surface of the Steam chat sender (same untyped
 * boundary as the welcome lane: @types/steam-user lacks
 * sendFriendMessage).
 */
export interface BanAlertChatClient {
  sendFriendMessage: (steamId: string, message: string) => Promise<unknown>;
}

/** Sends the localized generic ban-alert text. Lets send failures propagate. */
export const sendBanAlertMessage = async (
  chat: BanAlertChatClient,
  steamId: string,
  locale: string | null | undefined,
): Promise<void> => {
  if (typeof chat?.sendFriendMessage !== 'function') {
    throw new Error(
      'Steam chat sender unavailable: sendFriendMessage is not a function',
    );
  }
  await chat.sendFriendMessage(steamId, getBanAlertMessage(locale));
};
