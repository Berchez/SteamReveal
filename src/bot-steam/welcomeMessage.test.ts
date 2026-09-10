import {
  getWelcomeMessage,
  sendWelcomeMessage,
  DEFAULT_WELCOME_LOCALE,
  type WelcomeChatClient,
} from './welcomeMessage';

describe('getWelcomeMessage', () => {
  it('returns the template for each supported locale', () => {
    for (const locale of ['pt', 'en', 'es', 'de', 'ru']) {
      const message = getWelcomeMessage(locale);
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(20);
    }
  });

  it('matches by 2-letter prefix (pt-BR -> pt)', () => {
    expect(getWelcomeMessage('pt-BR')).toBe(getWelcomeMessage('pt'));
    expect(getWelcomeMessage('EN-us')).toBe(getWelcomeMessage('en'));
  });

  it('falls back to English for unknown, empty or absent locales', () => {
    for (const locale of ['xx', '', null, undefined]) {
      expect(getWelcomeMessage(locale)).toBe(
        getWelcomeMessage(DEFAULT_WELCOME_LOCALE),
      );
    }
  });

  it('every template explains how to leave and has no BBCode-bracket chars', () => {
    // steam-user escapes `[` as BBCode — a bracket would render mangled.
    for (const locale of ['pt', 'en', 'es', 'de', 'ru', null]) {
      expect(getWelcomeMessage(locale)).not.toContain('[');
    }
  });
});

describe('sendWelcomeMessage', () => {
  it('sends the localized text through the chat client', async () => {
    const sendFriendMessage = jest.fn(async () => ({}));

    await sendWelcomeMessage(
      { sendFriendMessage },
      '76561198000000001',
      'pt',
    );

    expect(sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(sendFriendMessage).toHaveBeenCalledWith(
      '76561198000000001',
      getWelcomeMessage('pt'),
    );
  });

  it('lets send failures propagate (caller decides retry policy)', async () => {
    const sendFriendMessage = jest.fn(async () => {
      throw new Error('steam down');
    });

    await expect(
      sendWelcomeMessage({ sendFriendMessage }, '76561198000000001', 'en'),
    ).rejects.toThrow('steam down');
  });

  it('fails clearly when the chat sender is missing (untyped boundary)', async () => {
    await expect(
      sendWelcomeMessage(
        {} as unknown as WelcomeChatClient,
        '76561198000000001',
        'en',
      ),
    ).rejects.toThrow('sendFriendMessage is not a function');
  });
});
