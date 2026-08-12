export const SUPPORTED_LOCALES = ['en', 'pt', 'ru'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_ROUTE_PATTERN = `(${SUPPORTED_LOCALES.join('|')})`;

export const LOCALE_PATHS: Record<SupportedLocale, string> = {
  en: '/en',
  pt: '/pt',
  ru: '/ru',
};
