import {
  COUNTRY_COOKIE,
  countryFromLanguage,
  getClientCountry,
  readCookie,
} from './clientCountry';

const clearCountryCookie = () => {
  document.cookie = `${COUNTRY_COOKIE}=; Max-Age=0; path=/`;
};

describe('clientCountry', () => {
  const originalLanguage = Object.getOwnPropertyDescriptor(
    navigator,
    'language',
  );

  afterEach(() => {
    clearCountryCookie();
    if (originalLanguage) {
      Object.defineProperty(navigator, 'language', originalLanguage);
    }
  });

  it('prefers the normalized country cookie', () => {
    document.cookie = `${COUNTRY_COOKIE}=br; path=/`;
    Object.defineProperty(navigator, 'language', {
      value: 'en-US',
      configurable: true,
    });

    expect(getClientCountry()).toBe('BR');
  });

  it('falls back to the region in navigator.language', () => {
    clearCountryCookie();
    Object.defineProperty(navigator, 'language', {
      value: 'pt-BR',
      configurable: true,
    });

    expect(getClientCountry()).toBe('BR');
  });

  it('returns null without a cookie or a language region', () => {
    clearCountryCookie();
    Object.defineProperty(navigator, 'language', {
      value: 'en',
      configurable: true,
    });

    expect(getClientCountry()).toBeNull();
  });

  it('extracts and uppercases valid language regions only', () => {
    expect(countryFromLanguage('de-DE')).toBe('DE');
    expect(countryFromLanguage('pt-br')).toBe('BR');
    expect(countryFromLanguage('en')).toBeNull();
    expect(countryFromLanguage('en-USA')).toBeNull();
    expect(countryFromLanguage(null)).toBeNull();
  });

  it('reads and clears cookies through the shared helper', () => {
    document.cookie = `${COUNTRY_COOKIE}=US; path=/`;
    expect(readCookie(COUNTRY_COOKIE)).toBe('US');

    clearCountryCookie();
    expect(readCookie(COUNTRY_COOKIE)).toBeNull();
  });
});
