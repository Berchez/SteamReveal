/**
 * Shared Watch message base (WB-15) — the single source of truth for every
 * user-facing Watch text, in the Steam bot and in the site inbox.
 *
 * Why a TS module instead of next-intl messages/*.json: the bot process
 * (ts-node, no React/intl provider) cannot use next-intl, and the inbox
 * needs deterministic text for a given event. Both sides call functions
 * from this same module, so the strings cannot drift unnoticed.
 * UI chrome that only the site needs (titles, buttons, aria labels,
 * empty/loading/error states) stays in messages/*.json under the Watch
 * namespace; anything the bot also sends lives here.
 *
 * Bot vs inbox split (deliberate, not drift): the bot sends the SHORT
 * teaser (getNotifyTeaserText — hook + link, nothing else) while the
 * site inbox renders localized per-search sentences from messages/*.json
 * (the bot process has no intl provider, so inbox copy cannot live here)
 * plus per-session details (viewed-at, cheater-check flag) from the
 * notifications API. Same locale/parity rules, separate lanes — each side
 * pinned by tests, so neither can silently change meaning.
 *
 * Rules for every template (enforced by tests):
 * - 8 locales, same arity: getWelcomeText(locale),
 *   getNotifyText(locale, steamId) and getNotifyTeaserText(locale,
 *   steamId) never throw and never return empty.
 * - No `[` characters: steam-user escapes them as BBCode and they would
 *   render mangled in Steam chat.
 */

export const WATCH_LOCALES = ['en', 'pt', 'es', 'de', 'ru', 'fr', 'uk', 'pl'] as const;

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
  fr: 'La surveillance SteamReveal de votre profil est active. Vous recevrez un message ici sur Steam chaque fois que quelqu\'un le consultera. Pour arrêter, retirez simplement ce bot de vos amis.',
  uk: 'Спостереження SteamReveal за вашим профілем активне. Ви отримуватимете повідомлення тут у Steam щоразу, коли його переглядатимуть. Щоб відписатися, просто видаліть цього бота з друзів.',
  pl: 'Obserwowanie Twojego profilu przez SteamReveal jest aktywne. Otrzymasz tu wiadomość na Steam za każdym razem, gdy ktoś go wyszuka. Aby zatrzymać, po prostu usuń tego bota ze znajomych.',
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
  fr: ({ nickname, link }) =>
    `Attention ! Quelqu'un vient de vérifier votre profil Steam${nickname ? ` (${nickname})` : ''} sur SteamReveal — voyez ce qu'ils ont vu :\n${link}`,
  uk: ({ nickname, link }) =>
    `Увага! Ваш профіль Steam${nickname ? ` (${nickname})` : ''} щойно шукали на SteamReveal — подивіться, що побачили:\n${link}`,
  pl: ({ nickname, link }) =>
    `Uwaga! Ktoś właśnie wyszukał Twój profil Steam${nickname ? ` (${nickname})` : ''} na SteamReveal — zobacz, co zobaczyli:\n${link}`,
};

const NOTIFY_TEASER_TEXT: Record<WatchMessageLocale, (content: NotifyContent) => string> = {
  // Bot-only hook (the inbox renders the full NOTIFY_TEXT instead): short
  // enough to read as a ping, never a summary. Same link rules as the full
  // text (own line, never glued to punctuation) and no opt-out line — the
  // welcome/first message owns that.
  en: ({ nickname, link }) =>
    `Someone just looked up your Steam profile${nickname ? ` (${nickname})` : ''} on SteamReveal — see what they saw:\n${link}`,
  pt: ({ nickname, link }) =>
    `Alguém buscou seu perfil Steam${nickname ? ` (${nickname})` : ''} no SteamReveal — veja a verificação aqui:\n${link}`,
  es: ({ nickname, link }) =>
    `Alguien acaba de buscar tu perfil de Steam${nickname ? ` (${nickname})` : ''} en SteamReveal — míralo aquí:\n${link}`,
  de: ({ nickname, link }) =>
    `Jemand hat gerade dein Steam-Profil${nickname ? ` (${nickname})` : ''} auf SteamReveal abgerufen — hier der Überblick:\n${link}`,
  ru: ({ nickname, link }) =>
    `Ваш профиль Steam${nickname ? ` (${nickname})` : ''} только что искали на SteamReveal — подробности здесь:\n${link}`,
  fr: ({ nickname, link }) =>
    `Quelqu'un vient de consulter votre profil Steam${nickname ? ` (${nickname})` : ''} sur SteamReveal — vérifiez ici :\n${link}`,
  uk: ({ nickname, link }) =>
    `Ваш профіль Steam${nickname ? ` (${nickname})` : ''} щойно шукали на SteamReveal — деталі тут:\n${link}`,
  pl: ({ nickname, link }) =>
    `Ktoś właśnie wyszukał Twój profil Steam${nickname ? ` (${nickname})` : ''} na SteamReveal — szczegóły tutaj:\n${link}`,
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
 *
 * RETAINED although no production caller remains (bot sends the teaser,
 * inbox renders next-intl templates): the language-contamination suite
 * below iterates this table per locale, and deleting it would shrink
 * that net. Tree-shaken out of both bundles — zero runtime cost.
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

/**
 * Bot-only teaser (WB-13 chat side): hook + player-page link, nothing
 * else. The inbox deliberately renders the FULL text (getNotifyText) plus
 * per-session details from the notifications API, so the chat ping reads
 * as an invitation to open the site instead of duplicating the inbox.
 * Same link/nickname mechanics as the full text (only the body differs).
 */
export const getNotifyTeaserText = (
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
  return NOTIFY_TEASER_TEXT[resolved]({
    nickname: opts.nickname ?? null,
    link,
  });
};

const CONFIRM_TEXT: Record<WatchMessageLocale, (url: string) => string> = {
  // The URL sits on its own line, NEVER glued to sentence punctuation:
  // Steam chat's linkifier swallows a trailing "." into the clickable
  // link, which used to arrive as a 65-char token and fail the shape
  // gate (user saw "invalid or expired" on a perfectly good link).
  // No opt-out line here by design — leaving lives in the welcome/first
  // message only; repeating it on every link nagged (see NOTIFY_TEXT).
  en: (url: string) =>
    `One last step to activate your SteamReveal Watch: open this link to confirm it's really you:\n${url}\nOnce confirmed, you'll get a Steam message here every time your watched profile is searched.`,
  pt: (url: string) =>
    `Falta um passo para ativar seu monitoramento SteamReveal: abra este link para confirmar que é você:\n${url}\nConfirmado, você recebe uma mensagem aqui na Steam sempre que seu perfil monitorado for buscado.`,
  es: (url: string) =>
    `Tu vigilancia de SteamReveal está a un paso: abre este enlace para confirmar que eres tú:\n${url}\nUna vez confirmado, recibirás un mensaje aquí en Steam cada vez que se busque tu perfil vigilado.`,
  de: (url: string) =>
    `Deine SteamReveal-Beobachtung ist fast aktiv: Öffne diesen Link, um zu bestätigen, dass du es bist:\n${url}\nNach der Bestätigung erhältst du hier auf Steam eine Nachricht, sobald dein beobachtetes Profil abgerufen wird.`,
  ru: (url: string) =>
    `До активации наблюдения SteamReveal остался один шаг: откройте эту ссылку, чтобы подтвердить, что это вы:\n${url}\nПосле подтверждения вы будете получать сообщение здесь в Steam каждый раз, когда наблюдаемый профиль будут просматривать.`,
  fr: (url: string) =>
    `Plus qu'une étape pour activer votre surveillance SteamReveal : ouvrez ce lien pour confirmer que c'est bien vous :\n${url}\nUne fois confirmé, vous recevrez un message ici sur Steam chaque fois que votre profil surveillé sera recherché.`,
  uk: (url: string) =>
    `До активації спостереження SteamReveal залишився один крок: відкрийте це посилання, щоб підтвердити, що це ви:\n${url}\nПісля підтвердження ви отримуватимете повідомлення тут у Steam щоразу, коли профіль під наглядом шукатимуть.`,
  pl: (url: string) =>
    `Został Ci jeden krok do aktywacji obserwowania SteamReveal: otwórz ten link, aby potwierdzić, że to Ty:\n${url}\nPo potwierdzeniu otrzymasz tu wiadomość na Steam za każdym razem, gdy Twój obserwowany profil będzie wyszukiwany.`,
};

/**
 * Signup-confirmation text (navbar-global flow): one step left, what the
 * link does, what follows. Carries the full confirm URL (built by the
 * caller with the freshly issued token).
 */
export const getConfirmText = (
  locale: string | null | undefined,
  url: string,
): string => CONFIRM_TEXT[resolveWatchLocale(locale)](url);

/**
 * Locale-correct date + time strings for the inbox row copy. Date order
 * (US MM/DD vs DD/MM vs DD.MM.) and the 12h/24h clock come from Intl, so
 * each locale reads its own convention — e.g. en "09/15 at 02:44 PM" vs
 * pt "15/09 as 14:44". No date library needed: Intl ships with the
 * runtime (Node 18+ and browsers) and is already used for the inbox
 * <time> element. Returns null for absent/invalid input — the component
 * falls back to empty strings so a corrupt row degrades textually.
 */
export type InboxSearchDateTime = {
  date: string;
  time: string;
};

export const getInboxSearchDateTime = (
  searchedAt: string | null | undefined,
  locale: string | null | undefined,
): InboxSearchDateTime | null => {
  if (!searchedAt) return null;
  const d = new Date(searchedAt);
  if (Number.isNaN(d.getTime())) return null;
  const resolved = resolveWatchLocale(locale);
  return {
    date: new Intl.DateTimeFormat(resolved, {
      day: '2-digit',
      month: '2-digit',
    }).format(d),
    time: new Intl.DateTimeFormat(resolved, {
      hour: '2-digit',
      minute: '2-digit',
    }).format(d),
  };
};

const CONFIRM_EXPIRED_TEXT: Record<WatchMessageLocale, string> = {
  // Like every bot-sent line: no `[` (Steam BBCode mangling). Points at
  // the site instead of carrying a link — the user generates a fresh one
  // there (the resend route), so this message needs no token and never
  // goes stale itself.
  en: 'Your confirm link expired. Open SteamReveal, sign in, and generate a new one from the Watch panel.',
  pt: 'Seu link de confirmação expirou. Abra o SteamReveal, entre com a Steam e gere um novo no painel do Watch.',
  es: 'Tu enlace de confirmación caducó. Abre SteamReveal, inicia sesión y genera uno nuevo en el panel de vigilancia.',
  de: 'Dein Bestätigungslink ist abgelaufen. Öffne SteamReveal, melde dich an und erstelle im Watch-Bereich einen neuen.',
  ru: 'Ссылка подтверждения истекла. Откройте SteamReveal, войдите и создайте новую на панели наблюдения.',
  fr: 'Votre lien de confirmation a expiré. Ouvrez SteamReveal, connectez-vous et générez-en un nouveau depuis le panneau de surveillance.',
  uk: 'Посилання-підтвердження прострочене. Відкрийте SteamReveal, увійдіть і згенеруйте нове на панелі спостереження.',
  pl: 'Twój link potwierdzający wygasł. Otwórz SteamReveal, zaloguj się i wygeneruj nowy w panelu obserwowania.',
};

/**
 * Expiry-notice text (click-to-activate flow): sent ONCE per token
 * generation when the link dies unclicked. Same 8-locale, never-throw,
 * never-empty contract as every template above.
 */
export const getConfirmExpiredText = (
  locale: string | null | undefined,
): string => CONFIRM_EXPIRED_TEXT[resolveWatchLocale(locale)];

const BAN_ALERT_TEXT: Record<WatchMessageLocale, string> = {
  // Ban Reveal alert (Phase 1): deliberately GENERIC — never names the
  // profile, nickname, or any identifying detail. The subscriber learns
  // WHICH profile only by opening the notifications tab and clicking
  // through the reveal (instrumented server-side). Same contract as every
  // template above: 8 locales, never throws, never empty, no `[`
  // (Steam BBCode mangling), no rich-text tags (bot prints verbatim).
  en: 'A profile you reviewed was flagged as banned. Open your notifications tab to see which.',
  pt: 'Um perfil que você analisou foi sinalizado como banido. Abra sua aba de notificações para ver qual.',
  es: 'Un perfil que revisaste fue marcado como baneado. Abre tu pestaña de notificaciones aquí para ver cuál.',
  de: 'Ein von dir geprüftes Profil wurde als gesperrt markiert. Öffne deinen Benachrichtigungs-Tab, um zu sehen, welches.',
  ru: 'Профиль, который вы проверяли, отмечен как забаненный. Откройте вкладку уведомлений, чтобы узнать какой.',
  fr: 'Un profil que vous avez examiné a été signalé comme banni. Ouvrez votre onglet de notifications pour voir lequel.',
  uk: 'Профіль, який ви переглядали, позначено як забанений. Відкрийте вкладку сповіщень, щоб дізнатися який.',
  pl: 'Profil, który przeglądałeś, został oznaczony jako zbanowany. Otwórz kartę powiadomień, aby zobaczyć który.',
};

/**
 * Ban-alert text (Ban Reveal Phase 1): generic by design — the profile is
 * revealed only after the instrumented reveal click, never in chat.
 */
export const getBanAlertText = (
  locale: string | null | undefined,
): string => BAN_ALERT_TEXT[resolveWatchLocale(locale)];
