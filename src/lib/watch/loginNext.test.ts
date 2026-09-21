import resolveLoginNext, { resolveLocaleHome } from './loginNext';

describe('resolveLoginNext', () => {
  it('re-attaches the locale to next-intl stripped pathnames', () => {
    expect(resolveLoginNext('/player/player-c', 'pt')).toBe(
      '/pt/player/player-c',
    );
    expect(resolveLoginNext('/', 'en')).toBe('/en/');
  });

  it('falls back to the locale home without a pathname', () => {
    expect(resolveLoginNext(null, 'pt')).toBe('/pt/');
    expect(resolveLoginNext('', 'pt')).toBe('/pt/');
  });

  it('passes already-prefixed values through untouched', () => {
    expect(resolveLoginNext('/pt/player/x', 'pt')).toBe('/pt/player/x');
    expect(resolveLoginNext('/pt', 'pt')).toBe('/pt/');
  });

  it('tolerates a missing leading slash', () => {
    expect(resolveLoginNext('player/x', 'es')).toBe('/es/player/x');
  });
});

describe('resolveLocaleHome', () => {
  it('maps stored locales to routable homes (variants fold to base)', () => {
    expect(resolveLocaleHome('pt')).toBe('/pt/');
    expect(resolveLocaleHome('pt-BR')).toBe('/pt/');
    expect(resolveLocaleHome('EN')).toBe('/en/');
  });

  it('lands unknown/absent locales on the bare home (never a 404)', () => {
    expect(resolveLocaleHome('xx')).toBe('/');
    expect(resolveLocaleHome(null)).toBe('/');
    expect(resolveLocaleHome(undefined)).toBe('/');
    expect(resolveLocaleHome('')).toBe('/');
    expect(resolveLocaleHome(42)).toBe('/');
  });
});
