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

const { listSentNotifications, countNotificationsSince } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  listSentNotifications: jest.Mock;
  countNotificationsSince: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const makeRequest = (url: string) =>
  ({
    method: 'GET',
    url,
  }) as unknown as Request;

const STEAM_ID = '76561198000000001';

describe('GET /api/watch/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    listSentNotifications.mockResolvedValue([]);
    countNotificationsSince.mockResolvedValue(0);
  });

  it('returns delivered notifications newest-first for a valid steamId', async () => {
    listSentNotifications.mockResolvedValue([
      { id: 9, sentAt: '2026-06-02T00:00:00.000Z' },
      { id: 7, sentAt: '2026-06-01T00:00:00.000Z' },
    ]);
    countNotificationsSince.mockResolvedValue(2);

    const res = await GET(
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}`,
      ),
    );
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

  it('forwards a valid limit and clamps an oversized one', async () => {
    await GET(
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&limit=5`,
      ),
    );
    expect(listSentNotifications).toHaveBeenCalledWith(STEAM_ID, 5);

    await GET(
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&limit=500`,
      ),
    );
    expect(listSentNotifications).toHaveBeenCalledWith(STEAM_ID, 50);
  });

  it('rejects missing/invalid steamId and invalid limit without touching the DAL', async () => {
    for (const url of [
      'http://localhost/api/watch/notifications',
      'http://localhost/api/watch/notifications?steamId=nope',
      `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&limit=0`,
      `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&limit=abc`,
      `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&limit=2.5`,
      `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&sinceSentAt=nope`,
      `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&sinceSentAt=`,
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
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}&sinceSentAt=2026-06-01T00:00:00.000Z`,
      ),
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
      url: `http://localhost/api/watch/notifications?steamId=${STEAM_ID}`,
    } as unknown as Request);
    expect(res.status).toBe(405);

    __testIsRateLimited.mockReturnValueOnce(true);
    const limited = await GET(
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}`,
      ),
    );
    expect(limited.status).toBe(429);
    expect(listSentNotifications).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL fails (no stack traces leak)', async () => {
    listSentNotifications.mockRejectedValue(new Error('db down'));
    const res = await GET(
      makeRequest(
        `http://localhost/api/watch/notifications?steamId=${STEAM_ID}`,
      ),
    );
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(JSON.stringify(body))).not.toContain('db down');
  });
});
