/**
 * Watch Bot welcome message (WB-11) — sent over Steam chat right after a
 * watch flips pending -> active.
 *
 * Templates live in @/lib/watch/notificationText (WB-15 shared base, not
 * in next-intl messages/*.json): the bot process has no React/intl
 * provider, the inbox renders the same base text, and these strings are
 * keyed by the requester locale stored on watched_profiles, not by any
 * page locale.
 *
 * Content contract (per ticket): explains what the watch does AND how to
 * leave (unfriend the bot). Keep every template free of `[` characters:
 * steam-user escapes them as BBCode and they would render mangled.
 */

import {
  DEFAULT_WATCH_LOCALE,
  getWelcomeText,
} from '@/lib/watch/notificationText';

export const DEFAULT_WELCOME_LOCALE = DEFAULT_WATCH_LOCALE;

/**
 * Resolves the template for a requester locale ('pt-BR' -> 'pt'),
 * falling back to English for anything unknown or absent.
 */
export const getWelcomeMessage = (locale: string | null | undefined): string =>
  getWelcomeText(locale);

/**
 * Minimal structural surface of the Steam chat sender (steam-user's
 * chat.sendFriendMessage is promise-based in the installed v5 — verified
 * in components/chatroom.js — but absent from @types/steam-user, hence
 * this interface instead of the library type).
 */
export interface WelcomeChatClient {
  sendFriendMessage: (steamId: string, message: string) => Promise<unknown>;
}

/** Sends the localized welcome text. Lets send failures propagate. */
export const sendWelcomeMessage = async (
  chat: WelcomeChatClient,
  steamId: string,
  locale: string | null | undefined,
): Promise<void> => {
  // The untyped boundary with steam-user (@types lacks sendFriendMessage):
  // fail with a clear operational message instead of a generic TypeError,
  // so logs/runbooks point at a client-version mismatch, not app logic.
  if (typeof chat?.sendFriendMessage !== 'function') {
    throw new Error(
      'Steam chat sender unavailable: sendFriendMessage is not a function',
    );
  }
  await chat.sendFriendMessage(steamId, getWelcomeMessage(locale));
};
