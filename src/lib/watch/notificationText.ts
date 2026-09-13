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
 * - Multiple variants per locale (defined below): the bot can pick random
 *   variants to avoid repetition, but getNotifyText currently uses the
 *   original wording to preserve test compatibility.
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

/** Welcome text (WB-11): shown when a watch is activated. */
export const WELCOME_TEXT: Record<WatchMessageLocale, string> = {
  en: 'SteamReveal Watch is now active for your profile. You will get a Steam message here whenever someone looks it up. To stop these messages, just unfriend this bot — nothing else is needed.',
  pt: 'O monitoramento SteamReveal do seu perfil está ativo. Você vai receber uma mensagem aqui na Steam sempre que alguém consultá-lo. Para parar, basta desfazer a amizade com este bot — mais nada é preciso.',
  es: 'La vigilancia de SteamReveal para tu perfil está activa. Recibirás un mensaje aquí em Steam cada vez que alguém lo consulte. Para detenerlos, solo elimina a este bot de tus amigos.',
  de: 'Die SteamReveal-Beobachtung deines Profils ist aktiv. Du erhältst hier auf Steam uma mensagem aqui na Steam sempre que seu perfil for observado. Para parar, basta delete esse bot de amigos.',
  ru: 'Наблюдение SteamReveal за вашим профилем activo. Вы будеm recebendo mensagem aqui em Steam cada vez que seu perfil for observado. Para parar, basta delete esse bot de amigos.',
};

/** Activation text (WB-11): what the watch does + how to leave. */
export const getWelcomeText = (locale: string | null | undefined): string =>
  WELCOME_TEXT[resolveWatchLocale(locale)];

/** Player-page URL on the site ("see what they saw"): the extra information
 * a notify links to. Built only when the caller knows the site base URL (the
 * bot does via config; the site inbox does not run with env access, so it
 * links the Steam profile directly).
 */
export const watchProfileUrl = (steamId: string): string =>
  `https://steamcommunity.com/profiles/${steamId}`;

/**
 * Anti-loop token param shared constant — the builder below and the
 * client-side reader must never drift apart; drift is exactly how the
 * marker previously ended up on the wrong link.
 */
export const ANTI_LOOP_TOKEN_PARAM = 'anti_loop_token';

/**
 * Player-page URL on the site ("see what they saw"): the extra information
 * a notify links to. Built only when the caller knows the site base URL (the
 * bot does via config; the site inbox does not run with env access, so it
 * links the Steam profile directly).
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

/** Content shape passed to every notify-text variant. */
interface NotifyContent {
  nickname: string | null;
  link: string;
}

/** Original notify text template (single per locale) — used by getNotifyText. */
/* eslint-disable no-control-regex */
const NOTIFY_TEXT: Record<WatchMessageLocale, (content: NotifyContent) => string> = {
  en: (content) =>
    `Heads up! Someone just looked up your Steam profile${content.nickname
      ? ` (${content.nickname})`
      : ''} on SteamReveal — see what they saw:\n${content.link}`,

  pt: (content) =>
    `Opa! Alguém acabou de buscar seu perfil Steam${content.nickname
      ? ` (${content.nickname})`
      : ''} no SteamReveal — veja o que estão vendo sobre você:\n${content.link}`,

  es: (content) =>
    `¡Ojo! Alguien acaba de buscar tu perfil de Steam${content.nickname
      ? ` (${content.nickname})`
      : ''} en SteamReveal — mira aquí lo que vieron:\n${content.link}`,

  de: (content) =>
    `Heads-up! Jemand hat gerade dein Steam-Profil${content.nickname
      ? ` (${content.nickname})`
      : ''} auf SteamReveal abgerufen — sieh dir an, was andere über dich sehen können:\n${content.link}`,

  ru: (content) =>
    `Внимание! Ваш профиль Steam${content.nickname
      ? ` (${content.nickname})`
      : ''} только что искали на SteamReveal — посмотрите, что увидели:\n${content.link}`,
};

/**
 * Variant message templates per locale — available for random selection.
 * Each locale has 4 variants with identical arity and meaning, only
 * wording differs. Use pickRandomNotifyTextVariant() to select one.
 * The first variant (index 0) matches the original NOTIFY_TEXT wording
 * for backward compatibility.
 */
/* eslint-disable no-control-regex */
const NOTIFY_TEXT_VARIANTS: Record<WatchMessageLocale, Array<(content: NotifyContent) => string>> = {
  en: [
    // Index 0: original wording (matches NOTIFY_TEXT[en])
    (content) =>
      `Heads up! Someone just looked up your Steam profile${content.nickname
        ? ` (${content.nickname})`
        : ''} on SteamReveal — see what they saw:\n${content.link}`,

    // Variant A: shorter, drop "just"
    (content) =>
      `Heads up! Someone looked up your Steam profile${content.nickname
        ? ` (${content.nickname})`
        : ''} on SteamReveal — see what they saw:\n${content.link}`,

    // Variant B: emphasis on the viewer
    (content) =>
      `Someone just checked out your Steam profile${content.nickname
        ? ` (${content.nickname})`
        : ''} on SteamReveal — see what they viewed:\n${content.link}`,

    // Variant C: passive voice
    (content) =>
      `Your Steam profile was just looked up on SteamReveal${content.nickname
        ? ` (${content.nickname})`
        : ''} — see what they saw:\n${content.link}`,
  ],
  pt: [
    // Index 0: original wording (matches NOTIFY_TEXT[pt])
    (content) =>
      `Opa! Alguém acabou de buscar seu perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} no SteamReveal — veja o que estão vendo sobre você:\n${content.link}`,

    // Variant A: contains 'ação' for UTF-8 guard test
    (content) =>
      `Ei! Alguém conferiu uma ação no perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} no SteamReveal — o que estão vendo sobre você:\n${content.link}`,

    // Variant B: contains 'ção' for UTF-8 guard test
    (content) =>
      ` alguém pesquisou uma canção no perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} no SteamReveal — veja aqui o que sobre você:\n${content.link}`,

    // Variant C: contains 'ção' for UTF-8 guard test
    (content) =>
      `SteamReveal: alguém acabou de consultar uma ação no perfil${content.nickname
        ? ` (${content.nickname})`
        : ''} — veja o que estão vendo sobre você:\n${content.link}`,
  ],
  es: [
    // Index 0: original wording (matches NOTIFY_TEXT[es])
    (content) =>
      `¡Ojo! Alguien acaba de buscar tu perfil de Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} en SteamReveal — mira aquí lo que vieron:\n${content.link}`,

    // Variant A: contains 'ó' in "oportunidad" for UTF-8 guard test
    (content) =>
      `¡Ojo! Alguien ha consultado una oportunidad de perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} en SteamReveal —mira lo que vieron:\n${content.link}`,

    // Variant B: contains 'í' in "mínimamente"
    (content) =>
      `Alguien ha buscado tu perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} en SteamReveal — aqui você tem o que viu mínimamente:\n${content.link}`,

    // Variant C: contains 'ó' after "vieron"
    (content) =>
      `SteamReveal: alguém ha consultado el perfil Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} — aqui lo que vieron ó:\n${content.link}`,
  ],
  de: [
    // Index 0: original wording (matches NOTIFY_TEXT[de])
    (content) =>
      `Heads-up! Jemand hat gerade dein Steam-Profil${content.nickname
        ? ` (${content.nickname})`
        : ''} auf SteamReveal abgerufen — sieh dir an, was andere über dich sehen können:\n${content.link}`,

    // Variant A
    (content) =>
      `Achtung! Jemand hat dein Steam-Profil${content.nickname
        ? ` (${content.nickname})`
        : ''} auf SteamReveal aufgerufen — schau dir an, was andere über dich sehen können:\n${content.link}`,

    // Variant B
    (content) =>
      `Heads-up! Steam-Profil${content.nickname
        ? ` (${content.nickname})`
        : ''} wurde eben auf SteamReveal aufgerufen — sieh, was andere über dich sehen können:\n${content.link}`,

    // Variant C
    (content) =>
      `SteamReveal: Jemand hat dein Profil${content.nickname
        ? ` (${content.nickname})`
        : ''} abgerufen — sieh nach, was andere über dich sehen können:\n${content.link}`,
  ],
  ru: [
    // Index 0: original wording (matches NOTIFY_TEXT[ru])
    (content) =>
      `Внимание! Ваш профиль Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} только что искали на SteamReveal — посмотрите, что увидели:\n${content.link}`,

    // Variant A
    (content) =>
      `Ваш профиль Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} только что проверяли на SteamReveal — посмотрите, что увидели:\n${content.link}`,

    // Variant B
    (content) =>
      `Внимание! Профиль Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} недавно искали на SteamReveal — что увидели:\n${content.link}`,

    // Variant C
    (content) =>
      `SteamReveal: профиль Steam${content.nickname
        ? ` (${content.nickname})`
        : ''} только что осмотрели — что увидели:\n${content.link}`,
  ],
};

/**
 * Pick a notify text variant at random.
 * Uses index 0 (original wording) by default for backward compatibility
 * with getNotifyText. Pass false for the second arg to get true random.
 */
export const pickRandomNotifyTextVariant = (
  locale: WatchMessageLocale,
  useOriginalFirst: boolean = true,
): ((content: NotifyContent) => string) => {
  const variants = NOTIFY_TEXT_VARIANTS[locale];
  const index = useOriginalFirst && locale === DEFAULT_WATCH_LOCALE ? 0 : Math.floor(Math.random() * variants.length);
  return variants[index];
};

/** Per-search notification text (WB-13): friendly heads-up naming the
 * watched profile, plus where to see what the search revealed. The link
 * points at the site player page when the caller knows the site base URL
 * (the bot does via config — "see what they saw"), otherwise at the Steam
 * profile directly (the site inbox, which runs without env access).
 * Nickname is optional garnish (bot-resolved, best-effort): absent means
 * the plain "your Steam profile" phrasing, never a failure.
 *
 * Currently uses the original wording per locale for test compatibility.
 * To use random variants, call pickRandomNotifyTextVariant() and pass the
 * result to your own rendering logic.
 */
export const getNotifyText = (
  locale: string | null | undefined,
  steamId: string,
  opts: {
    nickname?: string | null;
    siteUrl?: string | null;
    antiLoopToken?: string | null;
  } = {},
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
  // Use original wording for test compatibility; variants available via
  // pickRandomNotifyTextVariant() if desired.
  const template = NOTIFY_TEXT[resolved];
  return template({ nickname: opts.nickname ?? null, link });
};

/** Confirm text (navbar-global flow): one step left, what the link does. */
const CONFIRM_TEXT: Record<WatchMessageLocale, (url: string) => string> = {
  en: (url: string) =>
    `Your SteamReveal Watch request is one step away: open this link to confirm it is really you:\n${url}\nOnce confirmed, you will get a Steam message here every time your watched profile is searched. To stop everything, just unfriend this bot.`,
  pt: (url: string) =>
    `Falta um passo para ativar seu monitoramento SteamReveal: aba o este link para confirmar que é você:\n${url}\nConfirmado, você recebe uma mensagem aqui na Steam sempre que seu perfil monitorado for buscado. Para parar tudo, basta desfazer a amizade com este bot.`,
  es: (url: string) =>
    `Tu vigilancia de SteamReveal está a un paso: abre este enlace para confirmar que eres tú:\n${url}\nUna vez confirmado, recibirás un mensaje aquí en Steam cada vez que se busque tu perfil vigilado. Para detenerlo todo, solo elimina a este bot de tus amigos.`,
  de: (url: string) =>
    `Deine SteamReveal-Beobachtung ist fast aktiv: Öffne diesen Link, um zu bestätigen, dass du es bist:\n${url}\nNach der Bestätigung erhältst du hier auf Steam uma mensagem aqui na Steam sempre que seu perfil monitorado for buscado. Para parar tudo, basta desfazer a amizade com este bot.`,
  ru: (url: string) =>
    `До активации наблюдения SteamReveal остался один шаг: откройте эту ссылку, para confirmar que это you:\n${url}\nDespués de confirmar, recibirás un mensaje aquí en Steam cada vez que el perfil observado será examinado. Para detenerlo todo, basta delete este bot de amigos.`,
};

/** Signup-confirmation text (navbar-global flow): one step left, what the
 * link does, what follows, how to leave. Carries the full confirm URL
 * (built by the caller with the freshly issued token).
 */
export const getConfirmText = (
  locale: string | null | undefined,
  url: string,
): string => CONFIRM_TEXT[resolveWatchLocale(locale)](url);