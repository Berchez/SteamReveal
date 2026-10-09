/**
 * @jest-environment node
 */

import { GET } from './route';
import { resetReconnectThrottleForTests } from '@/lib/watch/reconnectThrottle';

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  resolveWatchSession: jest.fn(),
}));

jest.mock('@/lib/analytics/db', () => ({
  createAccount: jest.fn(),
}));

jest.mock('@/lib/watch/searcherAttribution', () => ({
  hasAccountFootprint: jest.fn(),
}));

jest.mock('@/lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// The route imports the timeout constant alongside the call — the mock
// factory must supply both (a module without BOT_FRIENDSHIP_TIMEOUT_MS
// fails the import, not the test).
jest.mock('@/lib/steamFriendList', () => ({
  BOT_FRIENDSHIP_TIMEOUT_MS: 8_000,
  isBotFriend: jest.fn(),
}));

// Passthrough by default: with real timers, an 8s timeout would slow the
// suite — the inconclusive tests override this with a rejection.
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

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};
const { createAccount } = jest.requireMock('@/lib/analytics/db') as {
  createAccount: jest.Mock;
};
const { hasAccountFootprint } = jest.requireMock(
  '@/lib/watch/searcherAttribution',
) as { hasAccountFootprint: jest.Mock };
const getSteamApiKey = jest.requireMock('@/lib/getSteamApiKey')
  .default as jest.Mock;
const { isBotFriend } = jest.requireMock('@/lib/steamFriendList') as {
  isBotFriend: jest.Mock;
};
const withTimeoutMock = jest.requireMock('@/lib/withTimeout').default as jest.Mock;
const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};
const mockLogRouteError = jest.requireMock('@/lib/logRouteError')
  .default as jest.Mock;

const STEAM = '76561198000000001';
const BOT = '76561199000000001';
const BASE = 'http://localhost:3000';
const BOT_PROFILE = `https://steamcommunity.com/profiles/${BOT}`;

const makeRequest = (url: string) =>
  new Request(`${BASE}${url}`, { method: 'GET' });

const bodyOf = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

describe('GET /api/history/reconnect', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Module-scoped per-viewer throttle: drop timestamps between tests
    // or an early GET would suppress the Steam read of a later one.
    resetReconnectThrottleForTests();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM,
    });
    hasAccountFootprint.mockResolvedValue(false);
    getSteamApiKey.mockReturnValue('test-api-key');
    process.env.STEAM_BOT_STEAMID = BOT;
    isBotFriend.mockResolvedValue(false);
    createAccount.mockResolvedValue({
      steamId: STEAM,
      createdAt: '2026-10-08T00:00:00.000Z',
      confirmedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
      locale: null,
      lastLoginAt: null,
    });
  });

  afterEach(() => {
    delete process.env.STEAM_BOT_STEAMID;
  });

  it('answers done immediately when the footprint already exists (no Steam read)', async () => {
    // The bot accepted while nobody polled (or a login elsewhere rebuilt
    // the row): the fast path makes the answer instant AND free — one
    // indexed PK read, zero GetFriendList quota.
    hasAccountFootprint.mockResolvedValue(true);

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: true,
      botProfileUrl: BOT_PROFILE,
    });
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('keeps waiting while friendship is not (yet) proven', async () => {
    // false = the expected steady state (sent has not landed / bot has
    // not accepted): silent, no mutation.
    isBotFriend.mockResolvedValueOnce(false);

    const res = await GET(makeRequest('/api/history/reconnect?locale=pt'));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    expect(createAccount).not.toHaveBeenCalled();
    expect(mockLogRouteError).not.toHaveBeenCalled();
  });

  it('keeps waiting and logs LOUDLY on an unknown friendship read', async () => {
    // null = Steam blip / private list: indistinguishable from "not
    // friend" for the answer, but never silently — a broken gate must
    // not read as "user is slow".
    isBotFriend.mockResolvedValueOnce(null);

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: BOT_PROFILE,
    });
    expect(createAccount).not.toHaveBeenCalled();
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect:friendship-unknown',
      expect.any(String),
      { steamId: STEAM },
    );
  });

  it('keeps waiting when the friendship read itself throws (timeout)', async () => {
    withTimeoutMock.mockRejectedValueOnce(new Error('GetFriendList timed out'));

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect((await bodyOf(res)).done).toBe(false);
    expect(createAccount).not.toHaveBeenCalled();
    // One blip, ONE log line: the detail-carrying friendship log fires
    // and the generic friendship-unknown stays reserved for isBotFriend
    // resolving null (private list) — no duplicated noise in ops.
    expect(mockLogRouteError).toHaveBeenCalledTimes(1);
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect:friendship',
      expect.any(String),
      { steamId: STEAM },
    );
    expect(mockLogRouteError).not.toHaveBeenCalledWith(
      'historyReconnect:friendship-unknown',
      expect.any(String),
      expect.anything(),
    );
  });

  it('recreates the attribution anchor when friendship is proven (history only)', async () => {
    isBotFriend.mockResolvedValueOnce(true);

    const res = await GET(makeRequest('/api/history/reconnect?locale=pt'));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: true,
      botProfileUrl: BOT_PROFILE,
    });
    // The anchor recreate takes the session id (self-scoped) and the
    // informational locale; it must NOT touch watches — resuming
    // notifications stays on the Start lane (consent gate).
    expect(createAccount).toHaveBeenCalledTimes(1);
    expect(createAccount).toHaveBeenCalledWith(STEAM, 'pt');
  });

  it('passes locale null through when the request omits it', async () => {
    isBotFriend.mockResolvedValueOnce(true);

    await GET(makeRequest('/api/history/reconnect'));

    expect(createAccount).toHaveBeenCalledWith(STEAM, null);
  });

  it('keeps waiting when the anchor write fails (transient, retried next tick)', async () => {
    isBotFriend.mockResolvedValueOnce(true);
    createAccount.mockRejectedValueOnce(new Error('turso blip'));

    const res = await GET(makeRequest('/api/history/reconnect'));

    // A DB blip must not 500 the wait — the poll retries idempotently —
    // but it logs loudly every time (sustained outage = visible).
    expect(res.status).toBe(200);
    expect((await bodyOf(res)).done).toBe(false);
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect:createAccount',
      expect.any(String),
      { steamId: STEAM },
    );
  });

  it('keeps waiting when the footprint read fails (no Steam read either)', async () => {
    hasAccountFootprint.mockRejectedValueOnce(new Error('db down'));

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect((await bodyOf(res)).done).toBe(false);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect:footprint',
      expect.any(String),
      { steamId: STEAM },
    );
  });

  it('refuses fail-closed and logs LOUDLY on a misconfigured friendship gate', async () => {
    getSteamApiKey.mockReturnValueOnce('');

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect((await bodyOf(res)).done).toBe(false);
    expect(isBotFriend).not.toHaveBeenCalled();
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect',
      expect.stringContaining('misconfigured'),
    );
  });

  it('returns 401 without a session (self-scoped lane)', async () => {
    resolveWatchSession.mockResolvedValueOnce({ status: 'unauthenticated' });

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(401);
    expect(hasAccountFootprint).not.toHaveBeenCalled();
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('rejects a cross-site fetch while allowing missing metadata (fail-open)', async () => {
    // Browsers always stamp fetch with Sec-Fetch-Site: a present
    // non-same-origin value is a forged drive-by (no-cors fetch sends
    // cookies). Missing header (curl, old browsers, bare test
    // Requests) stays allowed — the anchor recreated is always the
    // caller's own, and friendship is still re-proven below.
    const crossSite = new Request(`${BASE}/api/history/reconnect`, {
      method: 'GET',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    });
    const res = await GET(crossSite);

    expect(res.status).toBe(403);
    expect(hasAccountFootprint).not.toHaveBeenCalled();
    expect(isBotFriend).not.toHaveBeenCalled();

    const sameOrigin = new Request(`${BASE}/api/history/reconnect`, {
      method: 'GET',
      headers: { 'Sec-Fetch-Site': 'same-origin' },
    });
    isBotFriend.mockResolvedValue(false);
    const ok = await GET(sameOrigin);
    expect(ok.status).toBe(200);
    expect(isBotFriend).toHaveBeenCalledTimes(1);
  });

  it('rejects a client-supplied steamId (identity comes from the session)', async () => {
    const res = await GET(
      makeRequest('/api/history/reconnect?steamId=76561198000000002'),
    );

    expect(res.status).toBe(400);
    expect(hasAccountFootprint).not.toHaveBeenCalled();
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('sheds floods without touching Steam (per-IP cap)', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(429);
    expect(hasAccountFootprint).not.toHaveBeenCalled();
    expect(isBotFriend).not.toHaveBeenCalled();
  });

  it('answers botProfileUrl null when the bot env is missing (fail-soft CTA)', async () => {
    delete process.env.STEAM_BOT_STEAMID;

    const res = await GET(makeRequest('/api/history/reconnect'));

    expect(res.status).toBe(200);
    expect(await bodyOf(res)).toEqual({
      done: false,
      botProfileUrl: null,
    });
    // Misconfigured bot id is a broken gate (same loud fail-closed log
    // as a missing key) — the answer stays a wait, never a crash.
    expect(mockLogRouteError).toHaveBeenCalledWith(
      'historyReconnect',
      expect.stringContaining('misconfigured'),
    );
  });

  it('skips the Steam read when the same viewer polls twice inside the gap', async () => {
    // One waiter with N open tabs costs N GetFriendList reads per tick
    // against the shared quota: the second immediate poll answers
    // `{done:false}` without reading — the poll retries next tick.
    isBotFriend.mockResolvedValue(false);

    const first = await GET(makeRequest('/api/history/reconnect'));
    const second = await GET(makeRequest('/api/history/reconnect'));

    expect((await bodyOf(first)).done).toBe(false);
    expect((await bodyOf(second)).done).toBe(false);
    expect(isBotFriend).toHaveBeenCalledTimes(1);
    expect(createAccount).not.toHaveBeenCalled();
  });

  it('reads Steam again once the per-viewer gap has passed', async () => {
    isBotFriend.mockResolvedValue(false);
    const nowSpy = jest.spyOn(Date, 'now');

    nowSpy.mockReturnValue(1_000_000);
    await GET(makeRequest('/api/history/reconnect'));
    nowSpy.mockReturnValue(1_000_000 + 8_000);
    const res = await GET(makeRequest('/api/history/reconnect'));

    expect((await bodyOf(res)).done).toBe(false);
    expect(isBotFriend).toHaveBeenCalledTimes(2);
  });
});
