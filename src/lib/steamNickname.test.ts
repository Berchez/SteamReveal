import {
  sanitizeSteamNickname,
  STEAM_NICKNAME_MAX_LENGTH,
} from './steamNickname';

describe('sanitizeSteamNickname', () => {
  it('passes ordinary names through untouched', () => {
    expect(sanitizeSteamNickname('FalleN')).toBe('FalleN');
    expect(sanitizeSteamNickname('  spaced out  ')).toBe('spaced out');
    expect(sanitizeSteamNickname('Jöhnny_123')).toBe('Jöhnny_123');
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

  it('keeps brackets with stripBrackets:false, still killing controls/bidi', () => {
    // Navbar lane: Steam chat renders BBCode, our React HTML does not —
    // brackets are inert here, so clan tags survive while spoofing dies.
    expect(
      sanitizeSteamNickname('A\u202E[NAVI] s1mple\u0000', {
        stripBrackets: false,
      }),
    ).toBe('A[NAVI] s1mple');
    expect(sanitizeSteamNickname('[ABC] Player', { stripBrackets: false })).toBe(
      '[ABC] Player',
    );
    // ...but a brackets-only name is still printable (not a null fallthrough).
    expect(sanitizeSteamNickname('[]', { stripBrackets: false })).toBe('[]');
    // Length cap and non-string rules are option-independent.
    expect(
      sanitizeSteamNickname(`${'x'.repeat(40)}`, { stripBrackets: false }),
    ).toBe('x'.repeat(32));
    expect(sanitizeSteamNickname(null, { stripBrackets: false })).toBeNull();
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
