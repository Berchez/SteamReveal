import {
  DEFAULT_NOTIFY_LOCALE,
  getNotifyMessage,
  sendNotifyMessage,
} from './notifyMessage';

const STEAM = '76561198000000001';
const URL = `https://steamcommunity.com/profiles/${STEAM}`;

describe('getNotifyMessage', () => {
  it.each(['en', 'pt', 'es', 'de', 'ru'])(
    'renders a non-empty %s message naming the watched profile',
    (locale) => {
      const text = getNotifyMessage(locale, STEAM);

      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain(URL);
      expect(text).toContain(STEAM);
    },
  );

  it('resolves regional variants to the base language', () => {
    expect(getNotifyMessage('pt-BR', STEAM)).toBe(
      getNotifyMessage('pt', STEAM),
    );
    expect(getNotifyMessage('PT-br', STEAM)).toBe(
      getNotifyMessage('pt', STEAM),
    );
  });

  it('falls back to English for unknown, empty, or absent locales', () => {
    const english = getNotifyMessage(DEFAULT_NOTIFY_LOCALE, STEAM);

    expect(getNotifyMessage('xx', STEAM)).toBe(english);
    expect(getNotifyMessage('', STEAM)).toBe(english);
    expect(getNotifyMessage(null, STEAM)).toBe(english);
    expect(getNotifyMessage(undefined, STEAM)).toBe(english);
  });

  it('keeps every template free of [ (steam-user would mangle it as BBCode)', () => {
    for (const locale of ['en', 'pt', 'es', 'de', 'ru', 'xx', null]) {
      expect(getNotifyMessage(locale, STEAM)).not.toContain('[');
    }
  });

  it('ships intact UTF-8 (regression: Windows-codepage mojibake in diffs)', () => {
    // Diffs rendered in a CP850/1252 Windows terminal show these templates
    // as mojibake (Algu├®m, ð blocks) even when the file bytes are clean
    // UTF-8. These assertions pin the real scripts so a genuinely
    // corrupted file fails loudly instead of shipping mangled chat text.
    // Explicit Cyrillic block range U+0400–U+04FF (incl. Ё/ё): \p{...}/u
    // needs ES6+, but this repo targets ES5, so no property escapes.
    expect(getNotifyMessage('ru', STEAM)).toMatch(/[Ѐ-џ]/);
    expect(getNotifyMessage('pt', STEAM)).toMatch(/[ãç]/);
    expect(getNotifyMessage('es', STEAM)).toMatch(/[óí]/);
    expect(getNotifyMessage('de', STEAM)).toMatch(/[äöüÄÖÜß]/);
    for (const locale of ['en', 'pt', 'es', 'de', 'ru']) {
      // U+FFFD only appears when bytes are decoded with the wrong codec.
      expect(getNotifyMessage(locale, STEAM)).not.toContain('�');
    }
  });
});

describe('sendNotifyMessage', () => {
  it('sends the localized text to exactly the event recipient', async () => {
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

    await sendNotifyMessage({ sendFriendMessage }, STEAM, 'pt');

    expect(sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(sendFriendMessage).toHaveBeenCalledWith(
      STEAM,
      getNotifyMessage('pt', STEAM),
    );
  });

  it('fails loudly when the chat sender is missing (version mismatch)', async () => {
    await expect(sendNotifyMessage({} as never, STEAM, 'en')).rejects.toThrow(
      /sendFriendMessage is not a function/,
    );
    await expect(sendNotifyMessage(null as never, STEAM, 'en')).rejects.toThrow(
      /sendFriendMessage is not a function/,
    );
  });
});
