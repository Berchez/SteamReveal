import {
  DEFAULT_NOTIFY_LOCALE,
  getNotifyMessage,
  resolveNotifyDisplayName,
  sendConfirmExpiredMessage,
  sendConfirmMessage,
  sendNotifyMessage,
} from './notifyMessage';
import {
  getConfirmExpiredText,
  getConfirmText,
} from '../lib/watch/notificationText';

jest.mock('../lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('../lib/analytics/db', () => ({
  __esModule: true,
  issueAntiLoopToken: jest.fn(async () => true),
  hashAntiLoopToken: jest.fn((token: string) => `hash:${token}`),
  ANTI_LOOP_TOKEN_BYTES: 32,
  ANTI_LOOP_TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
}));

const mockedDb = jest.requireMock('../lib/analytics/db') as {
  issueAntiLoopToken: jest.Mock;
};

const mockedApiKey = jest.requireMock('../lib/getSteamApiKey')
  .default as jest.Mock;

const STEAM = '76561198000000001';
const URL = `https://steamcommunity.com/profiles/${STEAM}`;
const CONFIRM_URL =
  'https://steam-reveal.vercel.app/api/watch/confirm?token=abc';

// jsdom has no fetch: stub it per test via `mockFetchJson`.
const mockFetchJson = (json: unknown, ok = true) => {
  const fetchMock = jest.fn(async () => ({
    ok,
    json: async () => json,
  }));
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
};

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
    // as mojibake (Alguém, ð blocks) even when the file bytes are clean
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
  beforeEach(() => {
    mockedApiKey.mockReturnValue(undefined);
  });

  it('sends the localized text to exactly the event recipient', async () => {
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

    await sendNotifyMessage({ sendFriendMessage }, STEAM, 'pt');

    expect(sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(sendFriendMessage).toHaveBeenCalledWith(
      STEAM,
      getNotifyMessage('pt', STEAM),
    );
  });

  it('names the profile and links the player page when known', async () => {
    mockedApiKey.mockReturnValue('fake-key');
    const fetchMock = mockFetchJson({
      response: { players: [{ personaname: 'FalleN' }] },
    });
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

    await sendNotifyMessage(
      { sendFriendMessage },
      STEAM,
      'pt',
      'https://steam-reveal.vercel.app',
    );

    expect(sendFriendMessage).toHaveBeenCalledTimes(1);
    const [callSteamId, text] = sendFriendMessage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(callSteamId).toBe(STEAM);
    expect(text).toContain('(FalleN)');
    expect(text).toContain(
      `https://steam-reveal.vercel.app/pt/player/${STEAM}`,
    );
    // One lookup per send, Steam API only.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [fetchUrl] = fetchMock.mock.calls[0] as unknown as [string];
    expect(String(fetchUrl)).toContain('GetPlayerSummaries');
  });

  it('fails loudly when the chat sender is missing (version mismatch)', async () => {
    await expect(sendNotifyMessage({} as never, STEAM, 'en')).rejects.toThrow(
      /sendFriendMessage is not a function/,
    );
    await expect(sendNotifyMessage(null as never, STEAM, 'en')).rejects.toThrow(
      /sendFriendMessage is not a function/,
    );
  });

  it('embeds the issued anti-loop token in the player-page link', async () => {
    // Regression net for the unwired-token incident: the RAW token that
    // leaves in the link must hash to exactly what was stored, or the
    // route can never validate it and the loop guard is dead code.
    // (Module-level db mocks accumulate calls across tests — no
    // clearAllMocks in this file — so assert on the last call.)
    const mockedDb = jest.requireMock('../lib/analytics/db') as {
      issueAntiLoopToken: jest.Mock;
      hashAntiLoopToken: (token: string) => string;
    };
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));
    await sendNotifyMessage(
      { sendFriendMessage },
      STEAM,
      'en',
      'https://steam-reveal.vercel.app',
    );

    const calls = mockedDb.issueAntiLoopToken.mock.calls as unknown as Array<
      [string, string]
    >;
    const [issuedId, storedHash] = calls[calls.length - 1];
    expect(issuedId).toBe(STEAM);
    const [, text] = sendFriendMessage.mock.calls[0] as unknown as [
      string,
      string,
    ];
    const tokenInLink =
      /anti_loop_token=([0-9a-f]{64})/.exec(text)?.[1] ?? null;
    expect(tokenInLink).not.toBeNull();
    expect(mockedDb.hashAntiLoopToken(tokenInLink ?? '')).toBe(storedHash);
  });

  it('lets send failures propagate to caller per-row isolation', async () => {
    const sendFriendMessage = jest.fn(async () => {
      throw new Error('chat down');
    });

    await expect(
      sendNotifyMessage(
        { sendFriendMessage },
        STEAM,
        'en',
        'https://steam-reveal.vercel.app',
      ),
    ).rejects.toThrow('chat down');
  });

  it('fails closed when the watch row is gone: no dead-token message sends', async () => {
    // issueAntiLoopToken returns false when no watched_profiles row exists
    // (opt-out raced the send). The send must reject INSTEAD of embedding
    // a token that was never stored — otherwise the loop guard is dead
    // for this send while looking armed.
    mockedDb.issueAntiLoopToken.mockResolvedValueOnce(false);
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

    await expect(
      sendNotifyMessage(
        { sendFriendMessage },
        STEAM,
        'en',
        'https://steam-reveal.vercel.app',
      ),
    ).rejects.toThrow(/no watched profile left/);
    expect(sendFriendMessage).not.toHaveBeenCalled();
  });
});

describe('sendConfirmMessage', () => {
  it('sends the confirm link to exactly the new friend', async () => {
    const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

    await sendConfirmMessage({ sendFriendMessage }, STEAM, 'es', CONFIRM_URL);

    expect(sendFriendMessage).toHaveBeenCalledTimes(1);
    expect(sendFriendMessage).toHaveBeenCalledWith(
      STEAM,
      getConfirmText('es', CONFIRM_URL),
    );
  });

  it('fails loudly when the chat sender is missing (version mismatch)', async () => {
    await expect(
      sendConfirmMessage({} as never, STEAM, 'en', 'https://example.com'),
    ).rejects.toThrow(/sendFriendMessage is not a function/);
    await expect(
      sendConfirmMessage(null as never, STEAM, 'en', 'https://example.com'),
    ).rejects.toThrow(/sendFriendMessage is not a function/);
  });
});

describe('sendConfirmExpiredMessage', () => {
  it.each(['en', 'pt', 'es', 'de', 'ru'])(
    'sends the non-empty expiry notice in %s (never a link)',
    async (locale) => {
      const sendFriendMessage = jest.fn(async () => ({ ordinal: 1 }));

      await sendConfirmExpiredMessage({ sendFriendMessage }, STEAM, locale);

      expect(sendFriendMessage).toHaveBeenCalledTimes(1);
      const text = getConfirmExpiredText(locale);
      expect(text.length).toBeGreaterThan(0);
      expect(text).not.toContain('[');
      expect(sendFriendMessage).toHaveBeenCalledWith(STEAM, text);
    },
  );

  it('fails loudly when the chat sender is missing (version mismatch)', async () => {
    await expect(
      sendConfirmExpiredMessage({} as never, STEAM, 'en'),
    ).rejects.toThrow(/sendFriendMessage is not a function/);
  });
});

describe('resolveNotifyDisplayName', () => {
  beforeEach(() => {
    mockedApiKey.mockReturnValue(undefined);
  });

  it('returns null without a key (no fetch, notify still sends)', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('must not fetch without a key');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps personaname, blanks and failures to null (never throws)', async () => {
    mockedApiKey.mockReturnValue('fake-key');
    mockFetchJson({ response: { players: [{ personaname: 'FalleN' }] } });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBe('FalleN');

    mockFetchJson({ response: { players: [{ personaname: '' }] } });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();

    mockFetchJson({ response: { players: [] } });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();
  });

  it('sanitizes hostile nicknames: controls stripped, capped at 32', async () => {
    mockedApiKey.mockReturnValue('fake-key');
    // Control chars (incl. an injected newline) vanish; length caps at 32
    // codepoints without splitting the trailing emoji surrogate pair.
    mockFetchJson({
      response: { players: [{ personaname: 'AB\u0000CD\nEF\u007F' }] },
    });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBe('ABCDEF');

    // Bidi overrides (visual spoofing) are stripped like controls.
    mockFetchJson({
      response: { players: [{ personaname: 'A\u202EB' }] },
    });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBe('AB');

    // BBCode brackets die too: a nickname smuggling `[url=phish]` into
    // the bot's official message is a phishing primitive (same rule the
    // templates enforce — no `[` anywhere near Steam chat output).
    mockFetchJson({
      response: {
        players: [{ personaname: 'x[url=http://phish.example]click[/url]' }],
      },
    });
    const deBracketed = await resolveNotifyDisplayName(STEAM);
    expect(deBracketed).not.toContain('[');
    expect(deBracketed).not.toContain(']');
    // Brackets gone (33 chars stripped → 32-cap trims the tail).
    expect(deBracketed).toBe('xurl=http://phish.exampleclick/u');

    mockFetchJson({
      response: { players: [{ personaname: `${'x'.repeat(40)}😀` }] },
    });
    const capped = await resolveNotifyDisplayName(STEAM);
    expect(capped).toBe(`${'x'.repeat(32)}`);
    expect(Array.from(capped ?? '').length).toBe(32);

    // Nothing printable left (or only whitespace) degrades to null,
    // never an empty parens pair in the message.
    mockFetchJson({ response: { players: [{ personaname: ' \u0000 ' }] } });
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();
  });

  it('returns null when Steam answers non-ok or the fetch throws', async () => {
    mockedApiKey.mockReturnValue('fake-key');
    const fetchMock = jest.fn(async () => ({ ok: false, status: 403 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();

    const throwing = jest.fn(async () => {
      throw new Error('Steam down');
    });
    global.fetch = throwing as unknown as typeof fetch;
    await expect(resolveNotifyDisplayName(STEAM)).resolves.toBeNull();
  });
});
