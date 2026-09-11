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

jest.mock('next/headers', () => ({
  cookies: jest.fn(),
}));

jest.mock('@/lib/watch/session', () => ({
  resolveWatchSession: jest.fn(),
}));

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

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';

const makeRequest = (searchParams = '', method = 'GET') =>
  ({
    method,
    url: `http://localhost/api/watch/status${searchParams}`,
    headers: { get: jest.fn(() => null) },
  }) as unknown as Request;

describe('GET /api/watch/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({ status: 'authenticated', steamId: STEAM_ID });
  });

  it('returns pending for a pending watch', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('pending');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'pending' });
    expect(mockedDb.getWatchStatus).toHaveBeenCalledWith(STEAM_ID);
  });

  it('returns active for an active watch', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('active');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'active' });
  });

  it('returns none when no watch was ever requested', async () => {
    mockedDb.getWatchStatus.mockResolvedValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'none' });
  });

  it('returns none for an opted-out (deactivated) watch', async () => {
    // Opt-out DELETES the watched_profiles row, so a deactivated watch is
    // indistinguishable from never-requested at the DAL level — both are
    // getWatchStatus() === null, and both must read as 'none' (the
    // distinction is internal state this API deliberately hides).
    mockedDb.getWatchStatus.mockResolvedValue(null);

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ steamId: STEAM_ID, status: 'none' });
  });

  it('returns 401 without a login session (never touches the DAL)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });

    const res = await GET(makeRequest());

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      }),
    );
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('rejects any ?steamId= outright (self-scoped, no third-party lookups)', async () => {
    for (const searchParams of [
      `?steamId=${STEAM_ID}`,
      '?steamId=short',
      '?steamId=',
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

    const res = await GET(makeRequest());

    expect(res.status).toBe(429);
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods', async () => {
    const res = await GET(makeRequest('', 'POST'));

    expect(res.status).toBe(405);
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL throws', async () => {
    mockedDb.getWatchStatus.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
  });

  it('returns 500 when the session layer blows up (loud, not silent)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('SESSION_SECRET exploded'),
    });

    const res = await GET(makeRequest());

    expect(res.status).toBe(500);
    expect(mockedDb.getWatchStatus).not.toHaveBeenCalled();
  });

  it('never mutates watch state (read-only contract)', async () => {
    mockedDb.getWatchStatus.mockResolvedValue('pending');

    const res = await GET(makeRequest());

    expect(res.status).toBe(200);
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
    expect(mockedDb.deactivateWatch).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });
});
