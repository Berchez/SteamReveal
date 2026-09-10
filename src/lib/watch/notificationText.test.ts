import {
  DEFAULT_WATCH_LOCALE,
  getNotifyText,
  getWelcomeText,
  resolveWatchLocale,
  WATCH_LOCALES,
  watchProfileUrl,
} from './notificationText';

const STEAM = '76561198000000001';

describe('resolveWatchLocale', () => {
  it('resolves base languages and regional variants', () => {
    expect(resolveWatchLocale('pt')).toBe('pt');
    expect(resolveWatchLocale('pt-BR')).toBe('pt');
    expect(resolveWatchLocale('PT-br')).toBe('pt');
    expect(resolveWatchLocale('de')).toBe('de');
  });

  it('falls back to English for unknown, empty, or absent locales', () => {
    expect(resolveWatchLocale('xx')).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale('')).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale(null)).toBe(DEFAULT_WATCH_LOCALE);
    expect(resolveWatchLocale(undefined)).toBe(DEFAULT_WATCH_LOCALE);
  });
});

describe('shared watch message base', () => {
  it('covers exactly the 5 supported locales', () => {
    expect([...WATCH_LOCALES].sort()).toEqual(
      ['de', 'en', 'es', 'pt', 'ru'].sort(),
    );
  });

  it.each([...WATCH_LOCALES])('welcome text is non-empty in %s', (locale) => {
    expect(getWelcomeText(locale).length).toBeGreaterThan(0);
  });

  it.each([...WATCH_LOCALES])(
    'notify text names the watched profile in %s',
    (locale) => {
      const text = getNotifyText(locale, STEAM);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(STEAM);
      expect(text).toContain(watchProfileUrl(STEAM));
    },
  );

  it('never throws and falls back for unknown locales', () => {
    expect(() => getNotifyText('xx', STEAM)).not.toThrow();
    expect(getNotifyText('xx', STEAM)).toBe(
      getNotifyText(DEFAULT_WATCH_LOCALE, STEAM),
    );
    expect(getWelcomeText(null)).toBe(getWelcomeText(DEFAULT_WATCH_LOCALE));
  });

  it('keeps every template free of [ (Steam BBCode mangling)', () => {
    for (const locale of [...WATCH_LOCALES, 'xx', null]) {
      expect(getWelcomeText(locale)).not.toContain('[');
      expect(getNotifyText(locale, STEAM)).not.toContain('[');
    }
  });

  it('ships intact UTF-8 in every locale', () => {
    // Guards the Windows-codepage mojibake mirage at the byte level: real
    // Cyrillic / accented text must survive, never U+FFFD.
    expect(getNotifyText('ru', STEAM)).toMatch(/[Ѐ-џ]/);
    expect(getNotifyText('pt', STEAM)).toMatch(/[ãç]/);
    expect(getNotifyText('es', STEAM)).toMatch(/[óí]/);
    expect(getNotifyText('de', STEAM)).toMatch(/[äöüÄÖÜß]/);
    expect(getWelcomeText('ru')).toMatch(/[Ѐ-џ]/);
    for (const locale of WATCH_LOCALES) {
      expect(getWelcomeText(locale)).not.toContain('�');
      expect(getNotifyText(locale, STEAM)).not.toContain('�');
    }
  });
});
