export const SUPPORTED_LOCALES = ['en', 'pt', 'ru', 'de', 'es', 'fr', 'uk', 'pl'] as const;

export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

export const LOCALE_ROUTE_PATTERN = `(${SUPPORTED_LOCALES.join('|')})`;

export const LOCALE_PATHS: Record<SupportedLocale, string> = {
  en: '/en',
  pt: '/pt',
  ru: '/ru',
  de: '/de',
  es: '/es',
  fr: '/fr',
  uk: '/uk',
  pl: '/pl',
};

/**
 * Canonical site origin — SINGLE source for metadataBase, canonicals,
 * hreflang alternates and the sitemap (all must agree on one host, or
 * crawlers read the alternates as inconsistent). The alternates stay
 * RELATIVE and resolve against metadataBase (see [locale]/layout.tsx),
 * which points here.
 */
export const SITE_BASE_URL = 'https://steam-reveal.vercel.app';
