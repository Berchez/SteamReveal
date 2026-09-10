/**
 * Watch Bot notify message (WB-13) — sent over Steam chat for every consumed
 * `notify` event.
 *
 * Templates live in @/lib/watch/notificationText (WB-15 shared base, not
 * in next-intl messages/*.json): the bot process has no React/intl
 * provider, the site inbox renders the same base text for the same event,
 * and the language comes from the locale stored on watched_profiles, not
 * from any page locale. See the base module for the content contract.
 */

import {
  DEFAULT_WATCH_LOCALE,
  getNotifyText,
} from '@/lib/watch/notificationText';

export const DEFAULT_NOTIFY_LOCALE = DEFAULT_WATCH_LOCALE;

/**
 * Resolves the notify text for a requester locale ('pt-BR' -> 'pt'),
 * falling back to English for anything unknown or absent. Never throws
 * (unknown locales must degrade to English, not crash the poller).
 */
export const getNotifyMessage = (
  locale: string | null | undefined,
  steamId: string,
): string => getNotifyText(locale, steamId);

/**
 * Minimal structural surface of the Steam chat sender (steam-user's
 * chat.sendFriendMessage is promise-based in the installed v5 — verified
 * in components/chatroom.js — but absent from @types/steam-user, hence
 * this interface instead of the library type). NOTE: the Epic text says
 * "chatMessage", but that is the deprecated wrapper
 * (components/chat.js delegates it to chat.sendFriendMessage); callers
 * must use sendFriendMessage directly.
 */
export interface NotifyChatClient {
  sendFriendMessage: (steamId: string, message: string) => Promise<unknown>;
}

/** Sends the localized notify text. Lets send failures propagate. */
export const sendNotifyMessage = async (
  chat: NotifyChatClient,
  steamId: string,
  locale: string | null | undefined,
): Promise<void> => {
  // Same untyped-boundary guard as the welcome sender: fail with a clear
  // operational message instead of a generic TypeError.
  if (typeof chat?.sendFriendMessage !== 'function') {
    throw new Error(
      'Steam chat sender unavailable: sendFriendMessage is not a function',
    );
  }
  await chat.sendFriendMessage(steamId, getNotifyMessage(locale, steamId));
};
