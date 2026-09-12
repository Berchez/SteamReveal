import { SUPPORTED_LOCALES } from '@/locales';

/**
 * Post-login destination for the Steam OpenID `next` param.
 *
 * next-intl's usePathname() strips the locale prefix (`/pt/player/x` ->
 * `/player/x`), so callers put it back: the callback must land EXACTLY
 * where the user was, not rely on middleware locale re-detection (an
 * extra redirect that can also guess wrong). Already-prefixed values
 * (foreign callers, future next-intl behavior change) pass through
 * untouched. Null/empty falls back to the locale home.
 */
const resolveLoginNext = (
  pathname: string | null,
  locale: string,
): string => {
  if (pathname === null || pathname === '') return `/${locale}/`;
  if (pathname === `/${locale}`) return `/${locale}/`;
  if (pathname.startsWith(`/${locale}/`)) return pathname;
  return `/${locale}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
};

/**
 * Routable locale home for a STORED locale value (confirm-link landing).
 * Stored locales are format-checked at write time but NOT whitelisted
 * (region variants like `pt-BR` are legitimate for message templates,
 * which resolve by prefix) — so consumption must map to a routable home:
 * same prefix rule the message templates use (`slice(0, 2)`, lowercase),
 * restricted to the supported set. Unknown/absent values land on the bare
 * home (middleware locale detection), never a 404 under `/{garbage}/`.
 */
export const resolveLocaleHome = (locale: unknown): string => {
  const base = typeof locale === 'string' ? locale.slice(0, 2).toLowerCase() : '';
  return (SUPPORTED_LOCALES as readonly string[]).includes(base)
    ? `/${base}/`
    : '/';
};

export default resolveLoginNext;
