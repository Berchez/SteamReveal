/**
 * @jest-environment node
 *
 * Same RSC-testing constraints as getPlayerProfile.test.ts: `react.cache`
 * does not exist in plain Node/jest, so it is stubbed to identity (the
 * memoization is React's job in SSR, not what's under test here).
 */
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: (fn: unknown) => fn,
}));

// withTimeout duplicated the call; make it identity so the mocked fetch
// drives the outcome without a 4s race timer lingering in tests.
jest.mock('@/lib/withTimeout', () => ({
  __esModule: true,
  default: (fn: Promise<unknown>) => fn,
  SteamCallTimeoutError: class extends Error {},
}));

jest.mock('@/lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(() => 'fake-key'),
}));

import getSteamIdentity, {
  clearSteamIdentityCache,
} from './getSteamIdentity';

const STEAM = '76561198000000001';

const summaryResponse = (player: unknown) =>
  ({
    ok: true,
    json: async () => ({ response: { players: [player] } }),
  }) as Response;

const fetchMock = () => {
  const mock = jest.fn();
  global.fetch = mock as unknown as typeof fetch;
  return mock as jest.Mock;
};

describe('getSteamIdentity', () => {
  const realFetch = global.fetch;

  beforeEach(() => {
    // The TTL cache outlives single calls by design — reset it so each
    // case drives the mocked transport fresh.
    clearSteamIdentityCache();
    fetchMock().mockResolvedValue(
      summaryResponse({
        steamid: STEAM,
        personaname: 'AvatarUser',
        avatarmedium: 'https://cdn.test/a.jpg',
      }),
    );
  });

  afterEach(() => {
    global.fetch = realFetch;
    jest.restoreAllMocks();
  });

  it('maps nickname + medium avatar from the summary', async () => {
    await expect(getSteamIdentity(STEAM)).resolves.toEqual({
      nickname: 'AvatarUser',
      avatarUrl: 'https://cdn.test/a.jpg',
    });
  });

  it('calls GetPlayerSummaries for exactly the session id (never anything else)', async () => {
    const mock = global.fetch as unknown as jest.Mock;
    await getSteamIdentity(STEAM);

    expect(mock).toHaveBeenCalledTimes(1);
    const [url] = mock.mock.calls[0] as [string, RequestInit?];
    expect(url).toContain(
      'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/',
    );
    expect(url).toContain(`steamids=${STEAM}`);
  });

  it('returns null for malformed ids without touching Steam', async () => {
    const mock = global.fetch as unknown as jest.Mock;
    await expect(getSteamIdentity('short')).resolves.toBeNull();
    expect(mock).not.toHaveBeenCalled();
  });

  it('falls back to the steamId when the nickname is blank', async () => {
    (global.fetch as unknown as jest.Mock).mockResolvedValue(
      summaryResponse({
        steamid: STEAM,
        personaname: '',
        avatarmedium: 'https://cdn.test/b.jpg',
      }),
    );

    await expect(getSteamIdentity(STEAM)).resolves.toEqual({
      nickname: STEAM,
      avatarUrl: 'https://cdn.test/b.jpg',
    });
  });

  it('sanitizes a hostile personaname (same shared rules as the bot)', async () => {
    // Bidi/visual-spoofing + BBCode brackets must die before the name
    // reaches the global navbar; nothing printable still falls back.
    (global.fetch as unknown as jest.Mock).mockResolvedValue(
      summaryResponse({
        steamid: STEAM,
        personaname: 'A\u202E[url=http://phish.example]x[/url]',
        avatarmedium: 'https://cdn.test/c.jpg',
      }),
    );

    await expect(getSteamIdentity(STEAM)).resolves.toEqual({
      nickname: 'Aurl=http://phish.examplex/url',
      avatarUrl: 'https://cdn.test/c.jpg',
    });
  });

  it('returns null when the avatar is missing or Steam throws', async () => {
    const mock = global.fetch as unknown as jest.Mock;
    mock.mockResolvedValue(
      summaryResponse({
        steamid: STEAM,
        personaname: 'NoAvatar',
        avatarmedium: '',
      }),
    );
    await expect(getSteamIdentity(STEAM)).resolves.toBeNull();

    // Nulls are cached too (outage fallback must stay cheap) — clear to
    // exercise the throw path instead of the cached null.
    clearSteamIdentityCache();
    mock.mockRejectedValue(new Error('Steam down'));
    await expect(getSteamIdentity(STEAM)).resolves.toBeNull();

    clearSteamIdentityCache();
    mock.mockResolvedValue({ ok: false, status: 403 } as Response);
    await expect(getSteamIdentity(STEAM)).resolves.toBeNull();
  });

  it('serves repeat navigations from the TTL cache without touching Steam', async () => {
    const mock = global.fetch as unknown as jest.Mock;
    await expect(getSteamIdentity(STEAM)).resolves.toEqual({
      nickname: 'AvatarUser',
      avatarUrl: 'https://cdn.test/a.jpg',
    });
    await expect(getSteamIdentity(STEAM)).resolves.toEqual({
      nickname: 'AvatarUser',
      avatarUrl: 'https://cdn.test/a.jpg',
    });
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('returns the hermetic fixture in mock mode without touching Steam', async () => {
    const mock = global.fetch as unknown as jest.Mock;
    mock.mockRejectedValue(new Error('must not be called in mock mode'));
    const prevDevTest = process.env.DEV_TEST_MODE;
    const prevVercel = process.env.VERCEL_ENV;
    process.env.DEV_TEST_MODE = '1';
    delete process.env.VERCEL_ENV;
    try {
      await expect(getSteamIdentity(STEAM)).resolves.toEqual({
        nickname: 'MockUser',
        avatarUrl: expect.stringMatching(/^data:image\//),
      });
      expect(mock).not.toHaveBeenCalled();
    } finally {
      if (prevDevTest === undefined) delete process.env.DEV_TEST_MODE;
      else process.env.DEV_TEST_MODE = prevDevTest;
      if (prevVercel !== undefined) process.env.VERCEL_ENV = prevVercel;
    }
  });
});
