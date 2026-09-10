/**
 * @jest-environment node
 */

import { POST } from './route';
import INVITE_REREQUEST_AFTER_MS from '@/lib/watchInviteCooldown';

jest.mock('@/lib/analytics/db', () => ({
  createWatchRequest: jest.fn(),
  deactivateWatch: jest.fn(),
  enqueueEvent: jest.fn(),
  getWatchedProfile: jest.fn(),
  hasOpenInviteEvent: jest.fn(),
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
  hasOpenInviteEvent: jest.Mock;
  refreshWatchRequest: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const STEAM_ID = '76561198000000001';

const makeRequest = (overrides: {
  method?: string;
  jsonBody?: unknown;
  jsonError?: Error;
} = {}) => {
  const { method = 'POST', jsonBody = {}, jsonError } = overrides;
  return {
    method,
    headers: { get: jest.fn(() => null) },
    json: jsonError
      ? jest.fn().mockRejectedValue(jsonError)
      : jest.fn().mockResolvedValue(jsonBody),
  } as unknown as Request;
};

const profileRow = (overrides = {}) => ({
  steamId: STEAM_ID,
  status: 'pending',
  locale: null,
  requestedAt: new Date().toISOString(),
  activatedAt: null,
  lastNotifiedAt: null,
  ...overrides,
});

describe('POST /api/watch/request', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    mockedDb.enqueueEvent.mockResolvedValue({ eventId: 1, duplicate: false });
    mockedDb.refreshWatchRequest.mockResolvedValue(true);
  });

  it('rejects non-POST methods', async () => {
    const res = await POST(makeRequest({ method: 'GET' }));

    expect(res.status).toBe(405);
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
  });

  it('returns 429 when rate limited', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(429);
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(
      makeRequest({ jsonError: new SyntaxError('bad json') }),
    );

    expect(res.status).toBe(400);
  });

  it('returns 400 for missing/malformed steamId without touching the DAL', async () => {
    for (const jsonBody of [
      {},
      { steamId: 'short' },
      { steamId: 76561198000000001 },
      { steamId: null },
    ]) {
      const res = await POST(makeRequest({ jsonBody }));

      expect(res.status).toBe(400);
      expect(await res.json()).toEqual(
        expect.objectContaining({
          error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
        }),
      );
    }
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
  });

  it('creates a pending watch and queues the first invite for a new profile', async () => {
    mockedDb.getWatchedProfile.mockResolvedValue(null);
    mockedDb.createWatchRequest.mockResolvedValue(profileRow());

    const res = await POST(
      makeRequest({ jsonBody: { steamId: STEAM_ID, locale: 'pt' } }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      steamId: STEAM_ID,
      status: 'pending',
      inviteQueued: true,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.createWatchRequest).toHaveBeenCalledWith(STEAM_ID, 'pt');
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM_ID, 'invite');
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });

  it('returns current state without re-queueing for a fresh pending invite', async () => {
    mockedDb.getWatchedProfile.mockResolvedValue(
      profileRow({
        requestedAt: new Date(Date.now() - 3600000).toISOString(),
      }),
    );

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ steamId: STEAM_ID, status: 'pending', inviteQueued: false });
    expect(body.pendingExpiresInMs).toBeGreaterThan(0);
    expect(body.pendingExpiresInMs).toBeLessThanOrEqual(INVITE_REREQUEST_AFTER_MS);
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
  });

  it('re-queues and restarts the clock for an expired pending invite', async () => {
    mockedDb.getWatchedProfile.mockResolvedValue(
      profileRow({
        requestedAt: new Date(
          Date.now() - INVITE_REREQUEST_AFTER_MS - 3600000,
        ).toISOString(),
      }),
    );

    const res = await POST(
      makeRequest({ jsonBody: { steamId: STEAM_ID, locale: 'pt' } }),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      steamId: STEAM_ID,
      status: 'pending',
      inviteQueued: true,
      pendingExpiresInMs: null,
    });
    // The re-request locale rides along so the bot message language updates.
    expect(mockedDb.refreshWatchRequest).toHaveBeenCalledWith(STEAM_ID, 'pt');
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM_ID, 'invite');
  });

  it('returns active without queueing anything for an already-active watch', async () => {    mockedDb.getWatchedProfile.mockResolvedValue(
      profileRow({ status: 'active' }),
    );

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      steamId: STEAM_ID,
      status: 'active',
      inviteQueued: false,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });

  it('answers active (no blind enqueue) when the row activated mid-request', async () => {
    // Expired pending at first read, but refresh finds it already active:
    // someone (bot reconciliation) moved it concurrently. Truth over flow.
    mockedDb.getWatchedProfile.mockResolvedValueOnce(
      profileRow({
        requestedAt: new Date(
          Date.now() - INVITE_REREQUEST_AFTER_MS - 3600000,
        ).toISOString(),
      }),
    );
    mockedDb.refreshWatchRequest.mockResolvedValue(false);
    mockedDb.getWatchedProfile.mockResolvedValueOnce(
      profileRow({ status: 'active' }),
    );

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      steamId: STEAM_ID,
      status: 'active',
      inviteQueued: false,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('starts over when the row vanished mid-request (opt-out race)', async () => {
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(
        profileRow({
          requestedAt: new Date(
            Date.now() - INVITE_REREQUEST_AFTER_MS - 3600000,
          ).toISOString(),
        }),
      )
      .mockResolvedValueOnce(null);
    mockedDb.refreshWatchRequest.mockResolvedValue(false);
    mockedDb.createWatchRequest.mockResolvedValue(profileRow());

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      steamId: STEAM_ID,
      status: 'pending',
      inviteQueued: true,
    });
    expect(mockedDb.createWatchRequest).toHaveBeenCalledWith(STEAM_ID, null);
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM_ID, 'invite');
  });

  it('returns 500 when the DAL throws', async () => {
    mockedDb.getWatchedProfile.mockRejectedValue(new Error('db down'));

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(500);
  });

  it('rolls the fresh row back when enqueue fails after create (no 7-day trap)', async () => {
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        profileRow({ requestedAt: new Date().toISOString() }),
      );
    mockedDb.createWatchRequest.mockResolvedValue(profileRow());
    mockedDb.enqueueEvent.mockRejectedValue(new Error('db timeout'));
    mockedDb.hasOpenInviteEvent.mockResolvedValue(false);
    mockedDb.deactivateWatch.mockResolvedValue(true);

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(500);
    expect(mockedDb.deactivateWatch).toHaveBeenCalledWith(STEAM_ID);
  });

  it('keeps the row when a concurrent request queued an invite meanwhile', async () => {
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        profileRow({ requestedAt: new Date().toISOString() }),
      );
    mockedDb.createWatchRequest.mockResolvedValue(profileRow());
    mockedDb.enqueueEvent.mockRejectedValue(new Error('db timeout'));
    // The concurrent request's invite is open: deleting would orphan it
    // (accepted invite, no row to activate) — hands off instead.
    mockedDb.hasOpenInviteEvent.mockResolvedValue(true);

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(500);
    expect(mockedDb.deactivateWatch).not.toHaveBeenCalled();
  });

  it('leaves the row alone when it moved on before compensation (active race)', async () => {
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(profileRow({ status: 'active' }));
    mockedDb.createWatchRequest.mockResolvedValue(profileRow());
    mockedDb.enqueueEvent.mockRejectedValue(new Error('db timeout'));

    const res = await POST(makeRequest({ jsonBody: { steamId: STEAM_ID } }));

    expect(res.status).toBe(500);
    expect(mockedDb.deactivateWatch).not.toHaveBeenCalled();
  });
});
