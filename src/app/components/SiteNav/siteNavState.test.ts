/**
 * @jest-environment node
 */

import { resolveSiteNavState } from './siteNavState';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  resolveWatchSession: jest.fn(),
}));

jest.mock('@/lib/getSteamIdentity', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@/lib/analytics/db', () => ({
  getWatchStatus: jest.fn(),
  getAccount: jest.fn(),
}));

jest.mock('@/lib/watch/botLiveness', () => ({
  isBotOnline: jest.fn(),
}));

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const getSteamIdentity = jest.requireMock('@/lib/getSteamIdentity')
  .default as jest.Mock;

const { getWatchStatus, getAccount } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  getWatchStatus: jest.Mock;
  getAccount: jest.Mock;
};

const { isBotOnline } = jest.requireMock('@/lib/watch/botLiveness') as {
  isBotOnline: jest.Mock;
};

const STEAM = '76561198000000001';
const COOKIES = { get: jest.fn() };

describe('resolveSiteNavState', () => {
  const consoleError = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.console.error = consoleError;
    getWatchStatus.mockResolvedValue(null);
    getAccount.mockResolvedValue(null);
    // Bot-liveness gate default: online (button shows).
    isBotOnline.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('resolves the logged-in identity (avatar or id fallback)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    getSteamIdentity.mockResolvedValue({
      nickname: 'AvatarUser',
      avatarUrl: 'https://cdn.test/a.jpg',
    });

    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: STEAM,
      nickname: 'AvatarUser',
      avatarUrl: 'https://cdn.test/a.jpg',
      initialWatch: {
        status: 'none',
        confirmExpired: false,
        confirmLinkSent: false,
      },
    });

    getSteamIdentity.mockResolvedValue(null);
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: STEAM,
      nickname: STEAM,
      avatarUrl: null,
      initialWatch: {
        status: 'none',
        confirmExpired: false,
        confirmLinkSent: false,
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('seeds the dropdown first paint from the watch row + account', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    getSteamIdentity.mockResolvedValue({
      nickname: 'AvatarUser',
      avatarUrl: null,
    });
    getWatchStatus.mockResolvedValue('pending');
    getAccount.mockResolvedValue({
      confirmedAt: null,
      confirmTokenHash: 'ab'.repeat(32),
      confirmExpiresAt: '2999-01-01T00:00:00.000Z',
    });

    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: STEAM,
      nickname: 'AvatarUser',
      avatarUrl: null,
      initialWatch: {
        status: 'pending',
        confirmExpired: false,
        confirmLinkSent: true,
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('degrades a dead watch read to a cold open, never to logged-out', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    getSteamIdentity.mockResolvedValue({
      nickname: 'AvatarUser',
      avatarUrl: null,
    });
    getWatchStatus.mockRejectedValue(new Error('turso down'));
    // Save/restore (not just delete): next/jest loads .env into this
    // process, so a dev-local DATABASE_URL must survive the test.
    const prevDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'libsql://test.turso.io';
    try {
      await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
        steamId: STEAM,
        nickname: 'AvatarUser',
        avatarUrl: null,
        initialWatch: null,
      });
    } finally {
      if (prevDbUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = prevDbUrl;
      }
    }
    // Loud (env present = real failure), but the session survives: the
    // dropdown opens cold (skeleton) instead of logging the user out.
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('[SiteNav]');
  });

  it('fetches identity and the watch seed in parallel (slow avatar never blocks the seed)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    // Gate the Steam round-trip shut: with sequential awaits the DB reads
    // below could never fire until this releases.
    let releaseIdentity!: (value: unknown) => void;
    const identityGate = new Promise((resolve) => {
      releaseIdentity = resolve;
    });
    getSteamIdentity.mockReturnValue(identityGate);
    getWatchStatus.mockResolvedValue('active');
    getAccount.mockResolvedValue(null);

    const pending = resolveSiteNavState(COOKIES as never);
    // Flush the microtask queue several rounds: session resolve (local
    // crypto) plus both parallel lanes settle without any timer.
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
    expect(getWatchStatus).toHaveBeenCalledWith(STEAM);
    expect(getAccount).toHaveBeenCalledWith(STEAM);

    releaseIdentity({ nickname: 'SlowUser', avatarUrl: null });
    await expect(pending).resolves.toEqual({
      steamId: STEAM,
      nickname: 'SlowUser',
      avatarUrl: null,
      initialWatch: {
        status: 'active',
        confirmExpired: false,
        confirmLinkSent: false,
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders logged-out for unauthenticated sessions (quietly)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
      botOnline: true,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('reports bot offline to hide the sign-in button (the liveness gate)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });
    isBotOnline.mockResolvedValue(false);

    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
      botOnline: false,
    });
  });

  it('never calls the bot-liveness gate for logged-in sessions', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    getSteamIdentity.mockResolvedValue({
      nickname: 'AvatarUser',
      avatarUrl: null,
    });

    await resolveSiteNavState(COOKIES as never);

    expect(isBotOnline).not.toHaveBeenCalled();
  });

  it('degrades error sessions to logged-out WITH a trace (sick config must not read as idle)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('bad secret'),
    });
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
      botOnline: true,
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('[SiteNav]');
    expect(String(consoleError.mock.calls[0][0])).toContain('bad secret');
  });

  it('degrades to logged-out (loudly) on unexpected throws, never rejects', async () => {
    // The blast-radius contract: a broken session/avatar layer must cost
    // the bell, never the page. The bot-liveness flag fails OPEN in this
    // branch (the button must never hide on an unrelated surprise).
    resolveWatchSession.mockRejectedValue(new Error('cookie store blew up'));

    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
      botOnline: true,
    });
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(String(consoleError.mock.calls[0][0])).toContain('[SiteNav]');
    expect(String(consoleError.mock.calls[0][0])).toContain(
      'cookie store blew up',
    );

    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    getSteamIdentity.mockRejectedValue(new Error('steam exploded'));
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
      botOnline: true,
    });
    expect(consoleError).toHaveBeenCalledTimes(2);
    // No further liveness read inside the catch (fail-open is hardcoded).
    expect(isBotOnline).not.toHaveBeenCalled();
  });
});
