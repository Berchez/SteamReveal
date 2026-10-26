import { normalizeCountryCode } from '@/lib/countryFlag';

export const COUNTRY_COOKIE = 'steamreveal_country';

export const readCookie = (name: string): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const prefix = `${name}=`;
  const match = document.cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));

  if (!match) {
    return null;
  }

  try {
    return decodeURIComponent(match.slice(prefix.length));
  } catch {
    return null;
  }
};

export const countryFromLanguage = (language: string | null): string | null => {
  if (typeof language !== 'string') {
    return null;
  }

  const [, region] = language.split('-');
  return normalizeCountryCode(region);
};

export const getClientCountry = (): string | null => {
  if (typeof document === 'undefined') {
    return null;
  }

  const fromCookie = normalizeCountryCode(readCookie(COUNTRY_COOKIE));
  if (fromCookie !== null) {
    return fromCookie;
  }

  if (typeof navigator === 'undefined') {
    return null;
  }

  return countryFromLanguage(navigator.language ?? null);
};
