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

/**
 * Query param carrying the single-use anti-loop token on bot-generated
 * player-page links. Shared constant (not a magic string in N places):
 * the builder below and the client-side reader must never drift apart —
 * drift is exactly how the marker previously ended up on the wrong link.
 */
export const ANTI_LOOP_TOKEN_PARAM = 'anti_loop_token';

/**
 * Public player-page URL on the site ("see what they saw"): the extra
 * information a notify links to. Built only when the caller knows the
 * site base URL (the bot does via config; the site inbox does not run
 * with env access, so it links the Steam profile directly).
 */
export const watchPlayerPageUrl = (
  siteUrl: string,
  locale: WatchMessageLocale,
  steamId: string,
  antiLoopToken: string | null = null,
): string => {
  const base = `${siteUrl.replace(/\/+$/, '')}/${locale}/player/${steamId}`;
  return antiLoopToken
    ? `${base}?${ANTI_LOOP_TOKEN_PARAM}=${antiLoopToken}`
    : base;
};

interface NotifyContent {
  nickname: string | null;
  link: string;
}

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

const NOTIFY_TEXT: Record<WatchMessageLocale, (content: NotifyContent) => string> = {
  // The link sits on its own line, NEVER glued to sentence punctuation:
  // chat linkifiers swallow a trailing "." into the URL (proven live on
  // the confirm link). No opt-out line here by design — leaving lives in
  // the welcome/first message; every ping ending in "unfriend me" nagged.
  en: ({ nickname, link }) =>
    `Heads up! Someone just looked up your Steam profile${nickname ? ` (${nickname})` : ''} on SteamReveal — see what they saw:\n${link}`,
  pt: ({ nickname, link }) =>
    `Opa! Alguém acabou de buscar seu perfil Steam${nickname ? ` (${nickname})` : ''} no SteamReveal — veja o que estão vendo sobre você:\n${link}`,
  es: ({ nickname, link }) =>
    `¡Ojo! Alguien acaba de buscar tu perfil de Steam${nickname ? ` (${nickname})` : ''} en SteamReveal — mira aquí lo que vieron:\n${link}`,
  de: ({ nickname, link }) =>
    `Heads-up! Jemand hat gerade dein Steam-Profil${nickname ? ` (${nickname})` : ''} auf SteamReveal abgerufen — sieh dir an, was andere über dich sehen können:\n${link}`,
  ru: ({ nickname, link }) =>
    `Внимание! Ваш профиль Steam${nickname ? ` (${nickname})` : ''} только что искали на SteamReveal — посмотрите, что увидели:\n${link}`,
};

export interface NotifyTextOptions {
  nickname?: string | null;
  siteUrl?: string | null;
  antiLoopToken?: string | null;
}

/**
 * Per-search notification text (WB-13): friendly heads-up naming the
 * watched profile, plus where to see what the search revealed. The link
 * points at the site player page when the caller knows the site base URL
 * (the bot does via config — "see what they saw"), otherwise at the Steam
 * profile directly (the site inbox, which runs without env access).
 * Nickname is optional garnish (bot-resolved, best-effort): absent means
 * the plain "your Steam profile" phrasing, never a failure.
 */
export const getNotifyText = (
  locale: string | null | undefined,
  steamId: string,
  opts: NotifyTextOptions = {},
): string => {
  const resolved = resolveWatchLocale(locale);
  const siteUrl =
    typeof opts.siteUrl === 'string' && opts.siteUrl !== ''
      ? opts.siteUrl
      : null;
  const link =
    siteUrl === null
      ? watchProfileUrl(steamId)
      : watchPlayerPageUrl(siteUrl, resolved, steamId, opts.antiLoopToken ?? null);
  return NOTIFY_TEXT[resolved]({ nickname: opts.nickname ?? null, link });
};

const CONFIRM_TEXT: Record<WatchMessageLocale, (url: string) => string> = {
  // The URL sits on its own line, NEVER glued to sentence punctuation:
  // Steam chat's linkifier swallows a trailing "." into the clickable
  // link, which used to arrive as a 65-char token and fail the shape
  // gate (user saw "invalid or expired" on a perfectly good link).
  en: (url: string) =>
    `Your SteamReveal Watch request is one step away: open this link to confirm it is really you:\n${url}\nOnce confirmed, you will get a Steam message here every time your watched profile is searched. To stop everything, just unfriend this bot.`,
  pt: (url: string) =>
    `Falta um passo para ativar seu monitoramento SteamReveal: abra este link para confirmar que é você:\n${url}\nConfirmado, você recebe uma mensagem aqui na Steam sempre que seu perfil monitorado for buscado. Para parar tudo, basta desfazer a amizade com este bot.`,
  es: (url: string) =>
    `Tu vigilancia de SteamReveal está a un paso: abre este enlace para confirmar que eres tú:\n${url}\nUna vez confirmado, recibirás un mensaje aquí en Steam cada vez que se busque tu perfil vigilado. Para detenerlo todo, solo elimina a este bot de tus amigos.`,
  de: (url: string) =>
    `Deine SteamReveal-Beobachtung ist fast aktiv: Öffne diesen Link, um zu bestätigen, dass du es bist:\n${url}\nNach der Bestätigung erhältst du hier auf Steam eine Nachricht, sobald dein beobachtetes Profil abgerufen wird. Zum Beenden entferne diesen Bot einfach aus deiner Freundesliste.`,
  ru: (url: string) =>
    `До активации наблюдения SteamReveal остался один шаг: откройте эту ссылку, чтобы подтвердить, что это вы:\n${url}\nПосле подтверждения вы будете получать сообщение здесь в Steam каждый раз, когда наблюдаемый профиль будут просматривать. Чтобы всё остановить, просто удалите этого бота из друзей.`,
};

/**
 * Signup-confirmation text (navbar-global flow): one step left, what the
 * link does, what follows, how to leave. Carries the full confirm URL
 * (built by the caller with the freshly issued token).
 */
export const getConfirmText = (
  locale: string | null | undefined,
  url: string,
): string => CONFIRM_TEXT[resolveWatchLocale(locale)](url);
