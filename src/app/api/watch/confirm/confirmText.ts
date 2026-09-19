import type { WatchMessageLocale } from '@/lib/watch/notificationText';

export interface ConfirmPageText {
  lang: string;
  title: string;
  body: string;
  button: string;
  expiredTitle: string;
  expiredBody: string;
  homeLink: string;
}

// Lives here — NOT in route.ts: Next 14 rejects any non-route export from
// a route module at build time (`checkFields` type error on `next build`),
// so locale tables consumed by the confirm page live in this sidecar
// module instead. The page is the third locale-carrying surface alongside
// notificationText.ts and messages/*.json, and a missing/empty field here
// renders a broken page for exactly one language (see confirmText.test.ts).
export const CONFIRM_PAGE_TEXT: Record<WatchMessageLocale, ConfirmPageText> = {
  en: {
    lang: 'en',
    title: 'Confirm your Watch request',
    body: 'Clicking confirm proves it is really you. This activates SteamReveal monitoring for your profile and logs you in on this browser — you will get a message in Steam chat every time your watched profile is searched.',
    button: 'Confirm and activate',
    expiredTitle: 'This link expired',
    expiredBody:
      'Confirm links last 24 hours. Open SteamReveal, sign in, and generate a new one from the Watch panel.',
    homeLink: 'Open SteamReveal',
  },
  pt: {
    lang: 'pt',
    title: 'Confirme seu monitoramento',
    body: 'Ao confirmar, você prova que é você. Isso ativa o monitoramento SteamReveal do seu perfil e faz login neste navegador — você recebe uma mensagem no chat da Steam sempre que seu perfil monitorado for buscado.',
    button: 'Confirmar e ativar',
    expiredTitle: 'Este link expirou',
    expiredBody:
      'Links de confirmação valem por 24 horas. Abra o SteamReveal, entre com a Steam e gere um novo no painel do Watch.',
    homeLink: 'Abrir o SteamReveal',
  },
  es: {
    lang: 'es',
    title: 'Confirma tu vigilancia',
    body: 'Al confirmar, demuestras que eres tú. Esto activa la vigilancia de SteamReveal para tu perfil e inicia sesión en este navegador — recibirás un mensaje en el chat de Steam cada vez que se busque tu perfil vigilado.',
    button: 'Confirmar y activar',
    expiredTitle: 'Este enlace caducó',
    expiredBody:
      'Los enlaces de confirmación duran 24 horas. Abre SteamReveal, inicia sesión y genera uno nuevo en el panel de vigilancia.',
    homeLink: 'Abrir SteamReveal',
  },
  de: {
    lang: 'de',
    title: 'Bestätige deine Beobachtung',
    body: 'Mit der Bestätigung weist du nach, dass du es bist. Das aktiviert die SteamReveal-Beobachtung deines Profils und meldet dich in diesem Browser an — du erhältst eine Nachricht im Steam-Chat, sobald dein beobachtetes Profil abgerufen wird.',
    button: 'Bestätigen und aktivieren',
    expiredTitle: 'Dieser Link ist abgelaufen',
    expiredBody:
      'Bestätigungslinks gelten 24 Stunden. Öffne SteamReveal, melde dich an und erstelle im Watch-Bereich einen neuen.',
    homeLink: 'SteamReveal öffnen',
  },
  ru: {
    lang: 'ru',
    title: 'Подтверди свой мониторинг',
    body: 'Подтверждая, ты доказываешь, что это ты. Это активирует наблюдение SteamReveal за твоим профилем и входит в этом браузере — ты будешь получать сообщение в чате Steam каждый раз, когда наблюдаемый профиль будут просматривать.',
    button: 'Подтвердить и активировать',
    expiredTitle: 'Ссылка подтверждения истекла',
    expiredBody:
      'Ссылки подтверждения действуют 24 часа. Открой SteamReveal, войди и создай новую на панели наблюдения.',
    homeLink: 'Открыть SteamReveal',
  },
};
