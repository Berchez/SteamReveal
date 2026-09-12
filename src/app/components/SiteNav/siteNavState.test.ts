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

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const getSteamIdentity = jest.requireMock('@/lib/getSteamIdentity')
  .default as jest.Mock;

const STEAM = '76561198000000001';
const COOKIES = { get: jest.fn() };

describe('resolveSiteNavState', () => {
  const consoleError = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    global.console.error = consoleError;
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
    });

    getSteamIdentity.mockResolvedValue(null);
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: STEAM,
      nickname: STEAM,
      avatarUrl: null,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('renders logged-out for unauthenticated and error sessions alike', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
    });

    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('bad secret'),
    });
    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('degrades to logged-out (loudly) on unexpected throws, never rejects', async () => {
    // The blast-radius contract: a broken session/avatar layer must cost
    // the bell, never the page.
    resolveWatchSession.mockRejectedValue(new Error('cookie store blew up'));

    await expect(resolveSiteNavState(COOKIES as never)).resolves.toEqual({
      steamId: null,
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
    });
    expect(consoleError).toHaveBeenCalledTimes(2);
  });
});
