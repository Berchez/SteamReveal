/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/completeLogin', () => ({
  completeProvenLogin: jest.fn(),
}));

jest.mock('@/lib/watch/pendingLogin', () => ({
  getPendingLogin: jest.fn(),
  clearPendingLogin: jest.fn(),
}));

jest.mock('@/lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('@/lib/steamFriendList', () => ({
  isBotFriend: jest.fn(),
}));

// Passthrough by default: with real timers, an 8s timeout would slow the
// suite — the inconclusive test overrides this with a rejection.
jest.mock('@/lib/withTimeout', () => ({
  __esModule: true,
  default: jest.fn((promise: Promise<unknown>) => promise),
}));



jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

jest.mock('@/lib/logRouteError', () => ({
  __esModule: true,
  default: jest.fn(),
}));

const { cookies } = jest.requireMock('next/headers') as {
  cookies: jest.Mock;
};
const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};
const { completeProvenLogin } = jest.requireMock(
  '@/lib/watch/completeLogin',
) as {
  completeProvenLogin: jest.Mock;
};
const { getPendingLogin, clearPendingLogin } = jest.requireMock(
  '@/lib/watch/pendingLogin',
) as {
  getPendingLogin: jest.Mock;
  clearPendingLogin: jest.Mock;
};
const getSteamApiKey = jest.requireMock('@/lib/getSteamApiKey').default as jest.Mock;
const { isBotFriend } = jest.requireMock('@/lib/steamFriendList') as {
  isBotFriend: jest.Mock;
};
const withTimeoutMock = jest.requireMock('@/lib/withTimeout').default as jest.Mock;
const mockLogRouteError = jest.requireMock('@/lib/logRouteError')
  .default as jest.Mock;

const STEAM = '76561198000000001';
const BOT = '76561199000000001';
const BASE = 'http://localhost:3000';
const PENDING = `${BASE}/api/auth/steam/pending`;
const BOT_PROFILE = `https://steamcommunity.com/profiles/${BOT}`;

const PENDING_LOGIN = {
  kind: 'pending-login',
  steamId: STEAM,
  next: '/pt/player/player-c',
  expiresAt: Date.now() + 1000,
};

const bodyOf = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

describe('GET /api/auth/steam/pending', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    cookies.mockReturnValue({ get: jest.fn(), set: jest.fn() });
    getPendingLogin.mockResolvedValue({ ...PENDING_LOGIN });
    clearPendingLogin.mockResolvedValue(undefined);
    getSteamApiKey.mockReturnValue('test-api-key');
    process.env.STEAM_BOT_STEAMID = BOT;
    isBotFriend.mockResolvedValue(true);
    // Shared completion defaults to the idempotent re-completion.
    completeProvenLogin.mockResolvedValue({ activated: false, locale: 'pt' });
  });

  afterEach(() => {
    delete process.env.STEAM_BOT_STEAMID;
  });

  it('keeps waiting while the friendship is not (yet) proven', async () => {
    isBotFriend.mockResolvedValueOnce(false);

    const res = await GET(new Request(PENDING));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    // Nothing sealed, nothing written — the wait simply continues.
    expect(completeProvenLogin).not.toHaveBeenCalled();
    expect(clearPendingLogin).not.toHaveBeenCalled();
  });

  it('also keeps waiting on an inconclusive read (Steam blip recovers next tick)', async () => {
    isBotFriend.mockResolvedValueOnce(null);

    const res = await GET(new Request(PENDING));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    expect(completeProvenLogin).not.toHaveBeenCalled();

    withTimeoutMock.mockRejectedValueOnce(
      new Error('steamPending: GetFriendList timed out'),
    );
    const timedOut = await GET(new Request(PENDING));
    expect(await bodyOf(timedOut)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('logs loudly on UNKNOWN friendship but stays silent on plain not-yet-friend', async () => {
    // null (private list / dead key / outage): incident signal, every time.
    isBotFriend.mockResolvedValueOnce(null);
    await GET(new Request(PENDING));
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'steamPending:friendship-unknown',
      expect.stringContaining('unknown'),
      { steamId: STEAM },
    );

    // false (hasn't added yet): expected steady state, zero log noise.
    mockLogRouteError.mockClear();
    isBotFriend.mockResolvedValueOnce(false);
    await GET(new Request(PENDING));
    expect(mockLogRouteError).not.toHaveBeenCalled();
  });

  it('completes the login (seals, clears, redirects) once friendship is proven', async () => {
    // Store identity pinned like in the callback test: the completion
    // (and its login-funnel ctx read) must get the REQUEST cookie store —
    // the exact object cookies() returns — so the CTA cookie planted
    // before the wait is still readable when the poll completes.
    const requestStore = { get: jest.fn(), set: jest.fn() };
    cookies.mockReturnValue(requestStore);
    const res = await GET(new Request(PENDING));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: true,
      redirect: `${BASE}/pt/player/player-c`,
      botProfileUrl: BOT_PROFILE,
    });
    // The shared completion owns ensure/record/welcome/seal (pinned in
    // completeLogin.test.ts) — the route just passes through + clears.
    expect(completeProvenLogin).toHaveBeenCalledTimes(1);
    expect(completeProvenLogin).toHaveBeenCalledWith(
      requestStore,
      STEAM,
      '/pt/player/player-c',
      'steamPending',
    );
    expect(clearPendingLogin).toHaveBeenCalledTimes(1);
  });

  it('first completion (activated=true): lands with the watch=new param', async () => {
    completeProvenLogin.mockResolvedValueOnce({ activated: true, locale: 'pt' });

    const res = await GET(new Request(PENDING));

    expect(await bodyOf(res)).toEqual({
      done: true,
      redirect: `${BASE}/pt/player/player-c?watch=new`,
      botProfileUrl: BOT_PROFILE,
    });
    expect(clearPendingLogin).toHaveBeenCalledTimes(1);
  });

  it('two back-to-back completions welcome at most once (concurrent tabs converge)', async () => {
    // First tab flips (activated=true → welcome inside the helper);
    // second tab re-reads the now-active row (activated=false → silent).
    // The route-level guarantee: whatever the helper reports, the route
    // never enqueues or seals anything itself.
    completeProvenLogin
      .mockResolvedValueOnce({ activated: true, locale: 'pt' })
      .mockResolvedValueOnce({ activated: false, locale: 'pt' });

    const first = await GET(new Request(PENDING));
    const second = await GET(new Request(PENDING));

    expect((await bodyOf(first)).done).toBe(true);
    expect((await bodyOf(second)).done).toBe(true);
    expect(completeProvenLogin).toHaveBeenCalledTimes(2);
    // Single welcome lives inside the helper's exactly-once flip (pinned
    // in completeLogin.test.ts + the DAL race tests) — nothing here can
    // double it.
    expect(clearPendingLogin).toHaveBeenCalledTimes(2);
  });

  it('keeps waiting (never expires the room) when the shared completion throws', async () => {
    completeProvenLogin.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(new Request(PENDING));

    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    expect(clearPendingLogin).not.toHaveBeenCalled();
  });

  it('ends the wait as expired without a pending cookie (absent and forged alike)', async () => {
    getPendingLogin.mockResolvedValueOnce(null);

    const res = await GET(new Request(PENDING));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      expired: true,
      botProfileUrl: BOT_PROFILE,
    });
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('refuses fail-closed as expired when the gate is misconfigured', async () => {
    getSteamApiKey.mockReturnValueOnce(undefined);

    const noKey = await GET(new Request(PENDING));
    expect(await bodyOf(noKey)).toEqual({
      done: false,
      expired: true,
      botProfileUrl: BOT_PROFILE,
    });
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(completeProvenLogin).not.toHaveBeenCalled();

    process.env.STEAM_BOT_STEAMID = 'not-a-steamid';
    const badBotId = await GET(new Request(PENDING));
    expect(await bodyOf(badBotId)).toEqual({
      done: false,
      expired: true,
      botProfileUrl: null,
    });
    expect(completeProvenLogin).not.toHaveBeenCalled();
  });

  it('neutralizes a forged next inside the pending cookie (no open redirect)', async () => {
    // The callback validates `next` at issuance, but the stored value is
    // re-validated at consumption: a hand-minted pending can complete the
    // login yet never steer the landing off-origin.
    getPendingLogin.mockResolvedValueOnce({
      ...PENDING_LOGIN,
      next: 'https://evil.example/',
    });

    const res = await GET(new Request(PENDING));
    const body = await bodyOf(res);

    expect(body.done).toBe(true);
    expect(body.redirect).toBe(`${BASE}/`);
    expect(completeProvenLogin).toHaveBeenCalledWith(
      expect.anything(),
      STEAM,
      '/',
      'steamPending',
    );
  });

  it('rejects non-GET methods and rate-limited callers', async () => {
    const wrongMethod = await GET(
      new Request(PENDING, { method: 'POST' }),
    );
    expect(wrongMethod.status).toBe(405);

    __testIsRateLimited.mockReturnValueOnce(true);
    const limited = await GET(new Request(PENDING));
    expect(limited.status).toBe(429);
    expect(isBotFriend).not.toHaveBeenCalled();
  });
});
