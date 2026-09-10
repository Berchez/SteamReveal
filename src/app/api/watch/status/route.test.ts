/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  createWatchRequest: jest.fn(),
  deactivateWatch: jest.fn(),
  enqueueEvent: jest.fn(),
  getWatchedProfile: jest.fn(),
  getWatchStatus: jest.fn(),
  refreshWatchRequest: jest.fn(),
}));

// Same trick as recordAnalytics/route.test.ts: the factory runs once, so
// expose the limiter mock for per-test control.
jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const mockedDb = jest.requireMock('@/lib/analytics/db') as {
  createWatchRequest: jest.Mock;
  deactivateWatch: jest.Mock;
  enqueueEvent: jest.Mock;
  getWatchedProfile: jest.Mock;
  getWatchStatus: jest.Mock;
  refreshWatchRequest: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const STEAM_ID = '76561198000000001';

const makeRequest = (searchParams: string, method = 'GET') =>
  ({
    method,
    url: `http://localhost/api/watch/status${searchParams}`,
    headers: { get: jest.fn(() => null) },
  }) as unknown as Request;

describe('GET /api/watch/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
  });

  it('returns pending for a pending watch', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('pending');

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'pending' });
  });

  it('returns active for an active watch', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('active');

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'active' });
  });

  it('returns none when no watch was ever requested', async () => {
    mockedDb.getWatchStatus.mockResolvedValue(null);

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'none' });
  });

  it('returns none for an opted-out (deactivated) watch', async () => {
    // Opt-out DELETES the watched_profiles row, so a deactivated watch is
    // indistinguishable from never-requested at the DAL level — both are
    // getWatchStatus() === null, and both must read as 'none' (the
    // distinction is internal state this API deliberately hides).
    mockedDb.getWatchStatus.mockResolvedValue(null);

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'none' });
  });

  it('rejects missing/malformed steamId without touching the DAL', async () => {
    for (const searchParams of [
      '',
      '?steamId=',
      '?steamId=short',
      '?steamId=7656119800000000a',
      '?other=123',
    ]) {
      const res = await GET(makeRequest(searchParams));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
        }),
      );
    }
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(429);
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods', async () => {
    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`, 'POST'));

    expect(res.status).toBe(405);
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL throws', async () => {
    mockedDb.getWatchStatus.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(500);
  });

  it('never mutates watch state (read-only contract)', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('pending');

    const res = await GET(makeRequest(`?steamId=${STEAM_ID}`));

    expect(res.status).toBe(200);
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
    expect(mockedDb.deactivateWatch).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });
});
