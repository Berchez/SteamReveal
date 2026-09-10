/**
 * Watch Bot notify message (WB-13) — sent over Steam chat for every consumed
 * `notify` event.
 *
 * Same i18n precedent as welcomeMessage.ts: templates live here (not in
 * next-intl messages/*.json) because the bot process has no React/intl
 * provider, and the language comes from the locale stored on
 * watched_profiles, not from any page locale.
 *
 * Content contract: states that the watched profile was just looked up,
 * names the profile (Steam URL with the watched SteamID64, so the message
 * is unambiguous when one user watches several profiles), and repeats how
 * to leave (unfriend the bot). Keep every template free of `[`
 * characters: steam-user escapes them as BBCode and they would render
 * mangled.
 */

const profileUrl = (steamId: string): string =>
  `https://steamcommunity.com/profiles/${steamId}`;

const NOTIFY_TEMPLATES: Record<string, (steamId: string) => string> = {
  en: (steamId: string) =>
    `Someone just looked up the Steam profile you are watching: ${profileUrl(steamId)}. This is your SteamReveal Watch notification. To stop these messages, just unfriend this bot.`,
  pt: (steamId: string) =>
    `Alguém acabou de consultar o perfil Steam que você monitora: ${profileUrl(steamId)}. Esta é sua notificação do SteamReveal Watch. Para parar de receber, basta desfazer a amizade com este bot.`,
  es: (steamId: string) =>
    `Alguien acaba de consultar el perfil de Steam que vigilas: ${profileUrl(steamId)}. Esta es tu notificación de SteamReveal Watch. Para dejar de recibirlas, solo elimina a este bot de tus amigos.`,
  de: (steamId: string) =>
    `Jemand hat gerade das Steam-Profil abgerufen, das du beobachtest: ${profileUrl(steamId)}. Dies ist deine Benachrichtigung für SteamReveal Watch. Zum Abbestellen entferne diesen Bot einfach aus deiner Freundesliste.`,
  ru: (steamId: string) =>
    `Кто-то только что просмотрел профиль Steam, за которым вы наблюдаете: ${profileUrl(steamId)}. Это уведомление SteamReveal Watch. Чтобы отписаться, просто удалите этого бота из друзей.`,
};

export const DEFAULT_NOTIFY_LOCALE = 'en';

/**
 * Resolves the notify text for a requester locale ('pt-BR' -> 'pt'),
 * falling back to English for anything unknown or absent. Never throws
 * (unknown locales must degrade to English, not crash the poller).
 */
export const getNotifyMessage = (
  locale: string | null | undefined,
  steamId: string,
): string =>
  (
    NOTIFY_TEMPLATES[(locale ?? '').slice(0, 2).toLowerCase()] ??
    NOTIFY_TEMPLATES[DEFAULT_NOTIFY_LOCALE]
  )(steamId);

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
