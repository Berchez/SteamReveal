import axios from 'axios';

import {
  getRequesterDevice,
  getRequesterCountry,
  getRequesterBrowserLanguage,
  recordAnalytics,
  getAnalyticsSkipHeaders,
  getGamesSnapshot,
  isCounterStrikeActive,
} from './homeAnalyticsUtils';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

function makeTargetInfo(overrides: Record<string, unknown> = {}) {
  return {
    steamID: 'TARGET_ID',
    url: 'https://steamcommunity.com/id/target',
    nickname: 'TargetNick',
    countryCode: 'BR',
    stateCode: 'MG',
    cityID: 42,
    ...overrides,
  } as any;
}

function makeFriend(steamID: string, extra: Record<string, unknown> = {}) {
  return {
    friend: { steamID, nickname: steamID, countryCode: 'BR', ...extra },
    count: 5,
    probability: 80,
  } as any;
}

describe('getGamesSnapshot', () => {
  it('reads the nested `game.name`, converts playtime to hours, and sorts desc', () => {
    const games = [
      { game: { name: 'Dota 2' }, minutes: 600 }, // 10h
      { game: { name: 'CS2' }, minutes: 120 }, // 2h
      { game: { name: 'TF2' }, minutes: 300 }, // 5h
    ];
    const result = getGamesSnapshot(games as never);

    expect(result.map((g) => g.name)).toEqual(['Dota 2', 'TF2', 'CS2']);
    expect(result[0].playtimeHours).toBe(10);
    expect(result[1].playtimeHours).toBe(5);
    expect(result[2].playtimeHours).toBe(2);
  });

  it('falls back to a top-level `name` and `playtime_forever` when the nested shape is absent', () => {
    const games = [
      { name: 'Witcher 3', playtime_forever: 240 }, // 4h
      { game: { name: 'Portal' }, minutes: 60 }, // 1h
    ];
    const result = getGamesSnapshot(games as never);

    expect(result.map((g) => g.name)).toEqual(['Witcher 3', 'Portal']);
    expect(result[0].playtimeHours).toBe(4);
  });

  it('drops entries with a non-string name instead of coercing them', () => {
    const games = [
      { game: { name: 12345 }, minutes: 600 },
      { name: null, minutes: 300 },
      { game: { name: 'Playable' }, minutes: 60 },
    ];
    const result = getGamesSnapshot(games as never);

    expect(result.map((g) => g.name)).toEqual(['Playable']);
  });

  it('returns [] for undefined/empty input', () => {
    expect(getGamesSnapshot(undefined)).toEqual([]);
    expect(getGamesSnapshot([])).toEqual([]);
  });
});

describe('isCounterStrikeActive', () => {
  it('returns false for undefined / empty game lists', () => {
    expect(isCounterStrikeActive(undefined)).toBe(false);
    expect(isCounterStrikeActive([])).toBe(false);
  });

  it('returns true when a Counter-Strike game has >= 300h played', () => {
    expect(
      isCounterStrikeActive([
        { name: 'Counter-Strike 2', playtimeHours: 300 },
        { name: 'Dota 2', playtimeHours: 900 },
      ]),
    ).toBe(true);
  });

  it('returns true when Counter-Strike is the top-playtime game even under 300h', () => {
    // CS is not >= 300h, but it is the most-played game — the cost gate treats
    // an active CS family as worth the expensive cheater pipeline.
    expect(
      isCounterStrikeActive([
        { name: 'Counter-Strike 2', playtimeHours: 120 },
        { name: 'Valheim', playtimeHours: 80 },
      ]),
    ).toBe(true);
  });

  it('returns false when CS exists but is neither >= 300h nor the top game', () => {
    // Precondition (documented): the list is sorted by playtime desc, exactly
    // as getGamesSnapshot emits it — otherwise the "top game" branch is moot.
    expect(
      isCounterStrikeActive([
        { name: 'Elden Ring', playtimeHours: 500 },
        { name: 'Counter-Strike 2', playtimeHours: 20 },
      ]),
    ).toBe(false);
  });

  it('returns false when no Counter-Strike game is present at all', () => {
    expect(
      isCounterStrikeActive([
        { name: 'Dota 2', playtimeHours: 400 },
        { name: 'Rocket League', playtimeHours: 30 },
      ]),
    ).toBe(false);
  });

  it('is case-insensitive against the game name', () => {
    expect(
      isCounterStrikeActive([{ name: 'counter-strike: global offensive', playtimeHours: 400 }]),
    ).toBe(true);
  });
});

describe('getAnalyticsSkipHeaders', () => {
  const originalLocalStorage = window.localStorage;

  afterEach(() => {
    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  it('returns undefined when there is no password stored', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockReturnValue(null),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toBeUndefined();
  });

  it('returns the skip header when a password is stored', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockReturnValue('my-secret'),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toEqual({
      'x-analytics-skip-password': 'my-secret',
    });
  });

  it('returns undefined when localStorage throws (e.g. private mode)', () => {
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: jest.fn().mockImplementation(() => {
          throw new Error('SecurityError');
        }),
      },
      writable: true,
    });

    expect(getAnalyticsSkipHeaders()).toBeUndefined();
  });

  it('returns undefined when window is undefined (SSR)', () => {
    const originalWindow = global.window;
    // @ts-expect-error simulating SSR
    delete global.window;

    expect(getAnalyticsSkipHeaders()).toBeUndefined();

    global.window = originalWindow;
  });
});

describe('getRequesterDevice', () => {
  const originalUserAgent = navigator.userAgent;

  afterEach(() => {
    Object.defineProperty(navigator, 'userAgent', {
      value: originalUserAgent,
      configurable: true,
    });
  });

  it.each([
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)', 'mobile'],
    ['Mozilla/5.0 (Linux; Android 14; Pixel 8)', 'mobile'],
    ['Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', 'mobile'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'desktop'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'desktop'],
  ])('classifies "%s" as %s', (ua, expected) => {
    Object.defineProperty(navigator, 'userAgent', {
      value: ua,
      configurable: true,
    });

    expect(getRequesterDevice()).toBe(expected);
  });

  // "navigator unavailable (SSR)" is covered in homeAnalyticsUtils.ssr.test.ts
  // — see that file for why it isn't tested here.
});

describe('getRequesterCountry', () => {
  afterEach(() => {
    document.body.removeAttribute('data-country');
  });

  it('reads the data-country attribute off document.body', () => {
    document.body.setAttribute('data-country', 'BR');

    expect(getRequesterCountry()).toBe('BR');
  });

  it('returns null when the attribute is not set', () => {
    expect(getRequesterCountry()).toBeNull();
  });

  // "document unavailable (SSR)" is covered in homeAnalyticsUtils.ssr.test.ts
  // — see that file for why it isn't tested here.
});

describe('getRequesterBrowserLanguage', () => {
  const originalLanguage = Object.getOwnPropertyDescriptor(navigator, 'language');

  afterEach(() => {
    if (originalLanguage) {
      Object.defineProperty(navigator, 'language', originalLanguage);
    }
  });

  it.each([
    ['pt-BR', 'pt-BR'],
    ['en-US', 'en-US'],
    ['fr-FR', 'fr-FR'],
    ['de-DE', 'de-DE'],
    ['es-ES', 'es-ES'],
    ['ru-RU', 'ru-RU'],
  ])('returns "%s" when navigator.language is "%s"', (lang, expected) => {
    Object.defineProperty(navigator, 'language', {
      value: lang,
      configurable: true,
    });

    expect(getRequesterBrowserLanguage()).toBe(expected);
  });

  it('returns null when navigator.language is not available', () => {
    Object.defineProperty(navigator, 'language', {
      value: undefined,
      configurable: true,
    });

    expect(getRequesterBrowserLanguage()).toBeNull();
  });

  // "navigator unavailable (SSR)" is covered in homeAnalyticsUtils.ssr.test.ts
  // — see that file for why it isn't tested here.
});

describe('recordAnalytics', () => {
  const meta = {
    requesterLocale: 'pt-BR',
    requesterCountry: 'BR',
    requesterBrowserLanguage: 'pt-BR',
    device: 'desktop' as const,
    durationMs: 1234,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null without making any request when the target has no steamID', async () => {
    const result = await recordAnalytics(
      makeTargetInfo({ steamID: undefined }),
      [],
      [],
      meta,
    );

    expect(result).toBeNull();
    expect(mockedAxios.post).not.toHaveBeenCalled();
  });

  it('is best-effort about the GamersClub name lookup: a failure there does not block recordAnalytics', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.reject(new Error('gc lookup down'));
      }
      if (url === '/api/recordAnalytics') {
        return Promise.resolve({ data: { id: 'search-id' } });
      }
      return Promise.reject(new Error(`unexpected url ${url}`));
    });

    const result = await recordAnalytics(makeTargetInfo(), [], [], meta);

    expect(result).toBe('search-id');

    const recordCall = mockedAxios.post.mock.calls.find(
      ([url]) => url === '/api/recordAnalytics',
    );
    expect(recordCall?.[1]).toMatchObject({
      profile: expect.objectContaining({ gcName: null }),
    });
  });

  it('sends the analytics-skip headers with the recordAnalytics call', async () => {
    const originalLocalStorage = window.localStorage;
    Object.defineProperty(window, 'localStorage', {
      value: { getItem: jest.fn().mockReturnValue('skip-pass') },
      writable: true,
    });

    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.resolve({ data: { id: 'search-id' } });
    });

    await recordAnalytics(makeTargetInfo(), [], [], meta);

    const recordCall = mockedAxios.post.mock.calls.find(
      ([url]) => url === '/api/recordAnalytics',
    );
    expect(recordCall?.[2]).toEqual({
      headers: { 'x-analytics-skip-password': 'skip-pass' },
    });

    Object.defineProperty(window, 'localStorage', {
      value: originalLocalStorage,
      writable: true,
    });
  });

  it('maps close friends and truncates the location guess to the top 3', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: 'GCNick' } });
      }
      return Promise.resolve({ data: { id: 'search-id' } });
    });

    const friends = [makeFriend('f1'), makeFriend('f2')];
    const locations = [
      { location: 'A', probability: 50 },
      { location: 'B', probability: 30 },
      { location: 'C', probability: 15 },
      { location: 'D', probability: 5 },
    ] as any;

    await recordAnalytics(makeTargetInfo(), friends, locations, meta);

    const recordCall = mockedAxios.post.mock.calls.find(
      ([url]) => url === '/api/recordAnalytics',
    );
    const payload = recordCall?.[1] as any;

    expect(payload.friends).toHaveLength(2);
    expect(payload.friends[0]).toMatchObject({ steamId: 'f1', gcName: null });
    // Target's own gcName (fetched separately) is unrelated to each
    // friend's gcName, which the current implementation always sends as
    // null — this pins that behavior down explicitly.
    expect(payload.locationGuess).toHaveLength(3);
    expect(payload.requesterLocale).toBe('pt-BR');
    expect(payload.device).toBe('desktop');
    expect(payload.durationMs).toBe(1234);
  });

  it('includes a normalized gamesSnapshot and CS activity flag in the payload', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.resolve({ data: { id: 'search-id' } });
    });

    const target = makeTargetInfo({
      gamesSnapshot: [
        { name: 'Counter-Strike 2', playtimeHours: 420 },
        { name: 'Dota 2', playtimeHours: 100 },
      ],
    });

    await recordAnalytics(target, [], [], meta);

    const recordCall = mockedAxios.post.mock.calls.find(
      ([url]) => url === '/api/recordAnalytics',
    );
    const payload = recordCall?.[1] as any;

    expect(payload.isCSActive).toBe(true);
    expect(payload.gamesSnapshot).toEqual([
      { name: 'Counter-Strike 2', playtimeHours: 420 },
      { name: 'Dota 2', playtimeHours: 100 },
    ]);
  });

  it('returns null when the server reports the record was skipped', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.resolve({ data: { skipped: true } });
    });

    const result = await recordAnalytics(makeTargetInfo(), [], [], meta);

    expect(result).toBeNull();
  });

  it('swallows a failure of the recordAnalytics POST itself and returns null', async () => {
    mockedAxios.post.mockImplementation((url: string) => {
      if (url === '/api/getGamersClubName') {
        return Promise.resolve({ data: { gcName: null } });
      }
      return Promise.reject(new Error('server down'));
    });

    const result = await recordAnalytics(makeTargetInfo(), [], [], meta);

    expect(result).toBeNull();
  });
});
