/**
 * Watch Bot welcome message (WB-11) — sent over Steam chat right after a
 * watch flips pending -> active.
 *
 * Templates live here (not in next-intl messages/*.json): the bot process
 * has no React/intl provider, and these strings are keyed by the
 * requester locale stored on watched_profiles, not by any page locale.
 *
 * Content contract (per ticket): explains what the watch does AND how to
 * leave (unfriend the bot). Keep every template free of `[` characters:
 * steam-user escapes them as BBCode and they would render mangled.
 */

const WELCOME_TEMPLATES: Record<string, string> = {
  en: 'SteamReveal Watch is now active for your profile. You will get a Steam message here whenever someone looks it up. To stop these messages, just unfriend this bot — nothing else is needed.',
  pt: 'O monitoramento SteamReveal do seu perfil está ativo. Você vai receber uma mensagem aqui na Steam sempre que alguém consultá-lo. Para parar, basta desfazer a amizade com este bot — mais nada é preciso.',
  es: 'La vigilancia de SteamReveal para tu perfil está activa. Recibirás un mensaje aquí en Steam cada vez que alguien lo consulte. Para detenerlos, solo elimina a este bot de tus amigos.',
  de: 'Die SteamReveal-Beobachtung deines Profils ist aktiv. Du erhältst hier auf Steam eine Nachricht, sobald es jemand abruft. Zum Abbestellen entferne diesen Bot einfach aus deiner Freundesliste.',
  ru: 'Наблюдение SteamReveal за вашим профилем активно. Вы будете получать сообщение здесь в Steam каждый раз, когда его будут просматривать. Чтобы отписаться, просто удалите этого бота из друзей.',
};

export const DEFAULT_WELCOME_LOCALE = 'en';

/**
 * Resolves the template for a requester locale ('pt-BR' -> 'pt'),
 * falling back to English for anything unknown or absent.
 */
export const getWelcomeMessage = (locale: string | null | undefined): string =>
  WELCOME_TEMPLATES[(locale ?? '').slice(0, 2).toLowerCase()] ??
  WELCOME_TEMPLATES[DEFAULT_WELCOME_LOCALE];

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
