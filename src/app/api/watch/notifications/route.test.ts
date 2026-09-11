/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  listSentNotifications: jest.fn(),
  countNotificationsSince: jest.fn(),
}));

// Same per-file limiter trick as the sibling route tests: the factory runs
// once, so expose isRateLimited for the 429 test to flip.
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

const { listSentNotifications, countNotificationsSince } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  listSentNotifications: jest.Mock;
  countNotificationsSince: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const makeRequest = (url: string) =>
  ({
    method: 'GET',
    url,
  }) as unknown as Request;

const STEAM_ID = '76561198000000001';
const BASE = 'http://localhost/api/watch/notifications';

describe('GET /api/watch/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    listSentNotifications.mockResolvedValue([]);
    countNotificationsSince.mockResolvedValue(0);
  });

  it('returns delivered notifications newest-first for the session user', async () => {
    listSentNotifications.mockResolvedValue([
      { id: 9, sentAt: '2026-06-02T00:00:00.000Z' },
      { id: 7, sentAt: '2026-06-01T00:00:00.000Z' },
    ]);
    countNotificationsSince.mockResolvedValue(2);

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [
        { id: 9, sentAt: '2026-06-02T00:00:00.000Z' },
        { id: 7, sentAt: '2026-06-01T00:00:00.000Z' },
      ],
      unreadCount: 2,
    });
    expect(listSentNotifications).toHaveBeenCalledWith(STEAM_ID, 20);
    // No watermark sent: count from null (never opened).
    expect(countNotificationsSince).toHaveBeenCalledWith(STEAM_ID, null);
  });

  it('returns 401 without a login session (never touches the DAL)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      }),
    );
    expect(listSentNotifications).not.toHaveBeenCalled();
    expect(countNotificationsSince).not.toHaveBeenCalled();
  });

  it('forwards a valid limit and clamps an oversized one', async () => {
    await GET(makeRequest(`${BASE}?limit=5`));
    expect(listSentNotifications).toHaveBeenCalledWith(STEAM_ID, 5);

    await GET(makeRequest(`${BASE}?limit=500`));
    expect(listSentNotifications).toHaveBeenCalledWith(STEAM_ID, 50);
  });

  it('rejects any ?steamId= and invalid limit without touching the DAL', async () => {
    for (const url of [
      `${BASE}?steamId=${STEAM_ID}`,
      `${BASE}?steamId=nope`,
      `${BASE}?limit=0`,
      `${BASE}?limit=abc`,
      `${BASE}?limit=2.5`,
      `${BASE}?sinceSentAt=nope`,
      `${BASE}?sinceSentAt=`,
    ]) {
      const res = await GET(makeRequest(url));
      expect(res.status).toBe(400);
    }
    expect(listSentNotifications).not.toHaveBeenCalled();
    expect(countNotificationsSince).not.toHaveBeenCalled();
  });

  it('passes the client watermark through to the count', async () => {
    listSentNotifications.mockResolvedValue([
      { id: 30, sentAt: '2026-06-02T00:00:00.000Z' },
    ]);
    countNotificationsSince.mockResolvedValue(5);

    const res = await GET(
      makeRequest(`${BASE}?sinceSentAt=2026-06-01T00:00:00.000Z`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [{ id: 30, sentAt: '2026-06-02T00:00:00.000Z' }],
      unreadCount: 5,
    });
    expect(countNotificationsSince).toHaveBeenCalledWith(
      STEAM_ID,
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('rejects non-GET methods and rate-limited callers', async () => {
    const res = await GET({
      method: 'POST',
      url: BASE,
    } as unknown as Request);
    expect(res.status).toBe(405);

    __testIsRateLimited.mockReturnValueOnce(true);
    const limited = await GET(makeRequest(BASE));
    expect(limited.status).toBe(429);
    expect(listSentNotifications).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL fails (no stack traces leak)', async () => {
    listSentNotifications.mockRejectedValue(new Error('db down'));
    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(JSON.stringify(body))).not.toContain('db down');
  });

  it('returns 500 when the session layer blows up (loud, not silent)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('SESSION_SECRET exploded'),
    });

    const res = await GET(makeRequest(BASE));

    expect(res.status).toBe(500);
    expect(listSentNotifications).not.toHaveBeenCalled();
  });
});
