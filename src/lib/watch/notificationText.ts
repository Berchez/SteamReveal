/**
 * Shared Watch message base (WB-15) — the single source of truth for every
 * user-facing Watch text that must read identically in the Steam bot and
 * in the site inbox.
 *
 * Why a TS module instead of next-intl messages/*.json: the bot process
 * (ts-node, no React/intl provider) cannot use next-intl, and the inbox
 * needs the exact text the bot sent for a given event. Both sides call
 * the same function with the same arguments, so the strings cannot drift.
 * UI chrome that only the site needs (titles, buttons, aria labels,
 * empty/loading/error states) stays in messages/*.json under the Watch
 * namespace; anything the bot also sends lives here.
 *
 * Rules for every template (enforced by tests):
 * - 5 locales, same arity: getWelcomeText(locale) and
 *   getNotifyText(locale, steamId) never throw and never return empty.
 * - No `[` characters: steam-user escapes them as BBCode and they would
 *   render mangled in Steam chat.
 */

export const WATCH_LOCALES = ['en', 'pt', 'es', 'de', 'ru'] as const;

export type WatchMessageLocale = (typeof WATCH_LOCALES)[number];

export const DEFAULT_WATCH_LOCALE: WatchMessageLocale = 'en';

/** 'pt-BR' -> 'pt'; unknown/absent -> 'en'. Never throws. */
export const resolveWatchLocale = (
  locale: string | null | undefined,
): WatchMessageLocale => {
  const base = (locale ?? '').slice(0, 2).toLowerCase();
  return (WATCH_LOCALES as readonly string[]).includes(base)
    ? (base as WatchMessageLocale)
    : DEFAULT_WATCH_LOCALE;
};

export const watchProfileUrl = (steamId: string): string =>
  `https://steamcommunity.com/profiles/${steamId}`;

const WELCOME_TEXT: Record<WatchMessageLocale, string> = {
  en: 'SteamReveal Watch is now active for your profile. You will get a Steam message here whenever someone looks it up. To stop these messages, just unfriend this bot — nothing else is needed.',
  pt: 'O monitoramento SteamReveal do seu perfil está ativo. Você vai receber uma mensagem aqui na Steam sempre que alguém consultá-lo. Para parar, basta desfazer a amizade com este bot — mais nada é preciso.',
  es: 'La vigilancia de SteamReveal para tu perfil está activa. Recibirás un mensaje aquí en Steam cada vez que alguien lo consulte. Para detenerlos, solo elimina a este bot de tus amigos.',
  de: 'Die SteamReveal-Beobachtung deines Profils ist aktiv. Du erhältst hier auf Steam eine Nachricht, sobald es jemand abruft. Zum Abbestellen entferne diesen Bot einfach aus deiner Freundesliste.',
  ru: 'Наблюдение SteamReveal за вашим профилем активно. Вы будете получать сообщение здесь в Steam каждый раз, когда его будут просматривать. Чтобы отписаться, просто удалите этого бота из друзей.',
};

/** Activation text (WB-11): what the watch does + how to leave. */
export const getWelcomeText = (locale: string | null | undefined): string =>
  WELCOME_TEXT[resolveWatchLocale(locale)];

const NOTIFY_TEXT: Record<WatchMessageLocale, (steamId: string) => string> = {
  en: (steamId: string) =>
    `Someone just looked up the Steam profile you are watching: ${watchProfileUrl(steamId)}. This is your SteamReveal Watch notification. To stop these messages, just unfriend this bot.`,
  pt: (steamId: string) =>
    `Alguém acabou de consultar o perfil Steam que você monitora: ${watchProfileUrl(steamId)}. Esta é sua notificação do SteamReveal Watch. Para parar de receber, basta desfazer a amizade com este bot.`,
  es: (steamId: string) =>
    `Alguien acaba de consultar el perfil de Steam que vigilas: ${watchProfileUrl(steamId)}. Esta es tu notificación de SteamReveal Watch. Para dejar de recibirlas, solo elimina a este bot de tus amigos.`,
  de: (steamId: string) =>
    `Jemand hat gerade das Steam-Profil abgerufen, das du beobachtest: ${watchProfileUrl(steamId)}. Dies ist deine Benachrichtigung für SteamReveal Watch. Zum Abbestellen entferne diesen Bot einfach aus deiner Freundesliste.`,
  ru: (steamId: string) =>
    `Кто-то только что просмотрел профиль Steam, за которым вы наблюдаете: ${watchProfileUrl(steamId)}. Это уведомление SteamReveal Watch. Чтобы отписаться, просто удалите этого бота из друзей.`,
};

/**
 * Per-search notification text (WB-13): states that the watched profile
 * was just looked up and names it (URL with the watched SteamID64, so the
 * message stays unambiguous when one user watches several profiles).
 */
export const getNotifyText = (
  locale: string | null | undefined,
  steamId: string,
): string => NOTIFY_TEXT[resolveWatchLocale(locale)](steamId);
