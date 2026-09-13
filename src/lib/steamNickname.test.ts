import {
  sanitizeSteamNickname,
  STEAM_NICKNAME_MAX_LENGTH,
} from './steamNickname';

describe('sanitizeSteamNickname', () => {
  it('passes ordinary names through untouched', () => {
    expect(sanitizeSteamNickname('FalleN')).toBe('FalleN');
    expect(sanitizeSteamNickname('  spaced out  ')).toBe('spaced out');
    expect(sanitizeSteamNickname('Joãozinho_123')).toBe('Joãozinho_123');
  });

  it('strips controls, bidi overrides and BBCode brackets', () => {
    expect(sanitizeSteamNickname('AB\u0000CD\nEF\u007F')).toBe('ABCDEF');
    expect(sanitizeSteamNickname('A\u202EB')).toBe('AB');
    // A nickname smuggling a phishing link through the bot's message.
    // (33 chars after stripping → the 32-cap trims the tail; the point
    // is no bracket survives to form markup.)
    expect(
      sanitizeSteamNickname('x[url=http://phish.example]click[/url]'),
    ).toBe('xurl=http://phish.exampleclick/u');
    // Clan tags lose their brackets (safety over decoration, documented).
    expect(sanitizeSteamNickname('[ABC] Player')).toBe('ABC Player');
  });

  it('caps length codepoint-aware without splitting surrogate pairs', () => {
    const capped = sanitizeSteamNickname(`${'x'.repeat(40)}😀`);
    expect(capped).toBe('x'.repeat(32));
    expect(Array.from(capped ?? '').length).toBe(
      STEAM_NICKNAME_MAX_LENGTH,
    );
  });

  it('returns null for non-strings and nothing-printable (callers fall back)', () => {
    expect(sanitizeSteamNickname(null)).toBeNull();
    expect(sanitizeSteamNickname(undefined)).toBeNull();
    expect(sanitizeSteamNickname(42)).toBeNull();
    expect(sanitizeSteamNickname('')).toBeNull();
    expect(sanitizeSteamNickname(' \u0000 ')).toBeNull();
    expect(sanitizeSteamNickname('[]')).toBeNull();
  });
});
