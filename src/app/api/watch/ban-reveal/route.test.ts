/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  getBanSubscriptionById: jest.fn(),
  recordBanRevealClick: jest.fn(),
}));

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

const { getBanSubscriptionById, recordBanRevealClick } = jest.requireMock(
  '@/lib/analytics/db',
) as { getBanSubscriptionById: jest.Mock; recordBanRevealClick: jest.Mock };

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';
const TARGET = '76561198000000002';
const ORIGIN = 'http://localhost:3000';

const makeRequest = (jsonBody: unknown, origin: string | null = ORIGIN) =>
  ({
    method: 'POST',
    url: `${ORIGIN}/api/watch/ban-reveal`,
    json: jest.fn().mockResolvedValue(jsonBody),
    headers: {
      get: jest.fn((name: string) =>
        name.toLowerCase() === 'origin' ? origin : null,
      ),
    },
  }) as unknown as Request;

describe('POST /api/watch/ban-reveal', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    recordBanRevealClick.mockResolvedValue(undefined);
  });

  it('logs the click and returns the target to the owning subscriber', async () => {
    getBanSubscriptionById.mockResolvedValue({
      id: 7,
      subscriberSteamId: STEAM_ID,
      targetSteamId: TARGET,
      searchId: 's-1',
      subscribedAt: '2026-01-01T00:00:00.000Z',
      notifiedAt: '2026-02-01T00:00:00.000Z',
    });

    const res = await POST(makeRequest({ subscriptionId: 7 }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ subscriptionId: 7, targetSteamId: TARGET });
    expect(recordBanRevealClick).toHaveBeenCalledWith(STEAM_ID, TARGET);
  });

  it('still reveals when the click log fails (loud, never a 500)', async () => {
    getBanSubscriptionById.mockResolvedValue({
      id: 7,
      subscriberSteamId: STEAM_ID,
      targetSteamId: TARGET,
      searchId: null,
      subscribedAt: '2026-01-01T00:00:00.000Z',
      notifiedAt: '2026-02-01T00:00:00.000Z',
    });
    recordBanRevealClick.mockRejectedValueOnce(new Error('DB down'));

    const res = await POST(makeRequest({ subscriptionId: 7 }));
    expect(res.status).toBe(200);
    expect((await res.json()).targetSteamId).toBe(TARGET);
  });

  it('answers 404 for foreign or missing subscriptions (no oracle)', async () => {
    getBanSubscriptionById.mockResolvedValue({
      id: 7,
      subscriberSteamId: '76561198000000099',
      targetSteamId: TARGET,
      searchId: null,
      subscribedAt: '2026-01-01T00:00:00.000Z',
      notifiedAt: '2026-02-01T00:00:00.000Z',
    });
    const foreign = await POST(makeRequest({ subscriptionId: 7 }));
    expect(foreign.status).toBe(404);
    expect(recordBanRevealClick).not.toHaveBeenCalled();

    getBanSubscriptionById.mockResolvedValue(null);
    const missing = await POST(makeRequest({ subscriptionId: 8 }));
    expect(missing.status).toBe(404);
  });

  it('requires login, validates the id, and rate-limits', async () => {
    resolveWatchSession.mockResolvedValueOnce({ status: 'unauthenticated' });
    expect((await POST(makeRequest({ subscriptionId: 7 }))).status).toBe(401);

    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    expect((await POST(makeRequest({ subscriptionId: 0 }))).status).toBe(400);
    expect((await POST(makeRequest({}))).status).toBe(400);

    __testIsRateLimited.mockReturnValueOnce(true);
    expect((await POST(makeRequest({ subscriptionId: 7 }))).status).toBe(429);
  });

  it('rejects cross-origin and origin-less POSTs (CSRF fail-closed, like signup/logout)', async () => {
    const evil = await POST(
      makeRequest({ subscriptionId: 7 }, 'https://evil.example'),
    );
    expect(evil.status).toBe(403);
    expect(getBanSubscriptionById).not.toHaveBeenCalled();

    const missing = await POST(makeRequest({ subscriptionId: 7 }, null));
    expect(missing.status).toBe(403);
    expect(getBanSubscriptionById).not.toHaveBeenCalled();
  });
});
