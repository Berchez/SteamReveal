/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  createAccount: jest.fn(),
  createWatchRequest: jest.fn(),
  deactivateWatch: jest.fn(),
  enqueueEvent: jest.fn(),
  getWatchedProfile: jest.fn(),
  hasOpenInviteEvent: jest.fn(),
  refreshWatchRequest: jest.fn(),
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

const mockedDb = jest.requireMock('@/lib/analytics/db') as {
  createAccount: jest.Mock;
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

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';
const ORIGIN = 'http://localhost:3000';

const makeRequest = (
  overrides: {
    method?: string;
    jsonBody?: unknown;
    jsonError?: Error;
    origin?: string | null;
  } = {},
) => {
  const { method = 'POST', jsonBody = {}, jsonError, origin = ORIGIN } = overrides;
  return {
    method,
    url: `${ORIGIN}/api/auth/signup`,
    headers: {
      get: jest.fn((name: string) =>
        name.toLowerCase() === 'origin' ? origin : null,
      ),
    },
    json: jsonError
      ? jest.fn().mockRejectedValue(jsonError)
      : jest.fn().mockResolvedValue(jsonBody),
  } as unknown as Request;
};

const pendingRow = (requestedAt: string) => ({
  steamId: STEAM_ID,
  status: 'pending',
  locale: null,
  requestedAt,
  activatedAt: null,
  lastNotifiedAt: null,
});

describe('POST /api/auth/signup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    mockedDb.enqueueEvent.mockResolvedValue({ eventId: 1, duplicate: false });
    mockedDb.getWatchedProfile.mockResolvedValue(null);
  });

  it('creates account + watch + invite for the session profile, nothing else', async () => {
    const res = await POST(makeRequest({ jsonBody: { locale: 'pt' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      steamId: STEAM_ID,
      inviteQueued: true,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.createAccount).toHaveBeenCalledWith(STEAM_ID, 'pt');
    expect(mockedDb.createWatchRequest).toHaveBeenCalledWith(STEAM_ID, 'pt');
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(STEAM_ID, 'invite');
  });

  it('issues no token itself (the bot is the sole issuer at activation)', async () => {
    // Structural pin: the route module must not even reference token
    // issuance — only the wired DAL functions exist on its mock.
    // (If someone adds an issueConfirmToken call, this fails loudly.)
    const dbMock = jest.requireMock('@/lib/analytics/db') as Record<
      string,
      unknown
    >;
    expect(dbMock.issueConfirmToken).toBeUndefined();
    expect(dbMock.hashConfirmToken).toBeUndefined();

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(200);
    expect(mockedDb.createAccount).toHaveBeenCalledWith(STEAM_ID, null);
  });

  it('never re-enqueues for an already-active watch (friendship exists)', async () => {
    // The P1 that motivated the guard: without it every repeat signup
    // after a send burns one of the bot's 50/day global invites (the DAL
    // collapse only dedupes while a previous invite is still open).
    mockedDb.getWatchedProfile.mockResolvedValue({
      ...pendingRow(new Date().toISOString()),
      status: 'active',
    });

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      steamId: STEAM_ID,
      inviteQueued: false,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.createAccount).toHaveBeenCalledTimes(1);
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
  });

  it('holds a fresh pending row inside the 7-day window (no re-queue)', async () => {
    const requestedAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockedDb.getWatchedProfile.mockResolvedValue(pendingRow(requestedAt));

    const res = await POST(makeRequest({ jsonBody: {} }));
    const body = (await res.json()) as {
      inviteQueued: boolean;
      pendingExpiresInMs: number;
    };

    expect(res.status).toBe(200);
    expect(body.inviteQueued).toBe(false);
    // ~6 days left, within the 7-day window (1s tolerance for the clock).
    expect(body.pendingExpiresInMs).toBeGreaterThan(5 * 24 * 3600 * 1000);
    expect(body.pendingExpiresInMs).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });

  it('absorbs a redundant signup when warm cache said none but a fresh pending row exists', async () => {
    // Warm-start hazard (avatar prefetch): the panel can paint 'none' from
    // a stale cache and offer Start, while the live row is actually a fresh
    // pending watch. Clicking Start then must be a safe no-op — success,
    // no new row, no extra invite — never a duplicate side effect.
    const requestedAt = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    mockedDb.getWatchedProfile.mockResolvedValue(pendingRow(requestedAt));

    const res = await POST(makeRequest({ jsonBody: { locale: 'pt' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      steamId: STEAM_ID,
      inviteQueued: false,
      pendingExpiresInMs: expect.any(Number),
    });
    expect(mockedDb.createWatchRequest).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
    expect(mockedDb.refreshWatchRequest).not.toHaveBeenCalled();
  });

  it('refreshes + re-queues an expired pending row', async () => {
    const requestedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    mockedDb.getWatchedProfile.mockResolvedValue(pendingRow(requestedAt));
    mockedDb.refreshWatchRequest.mockResolvedValue(true);

    const res = await POST(makeRequest({ jsonBody: { locale: 'es' } }));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      steamId: STEAM_ID,
      inviteQueued: true,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.refreshWatchRequest).toHaveBeenCalledWith(STEAM_ID, 'es');
    expect(mockedDb.enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('answers the truth when refresh loses the race to activation', async () => {
    const requestedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(pendingRow(requestedAt))
      .mockResolvedValueOnce({
        ...pendingRow(requestedAt),
        status: 'active',
      });
    mockedDb.refreshWatchRequest.mockResolvedValue(false);

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(await res.json()).toEqual({
      ok: true,
      steamId: STEAM_ID,
      inviteQueued: false,
      pendingExpiresInMs: null,
    });
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('restarts as brand-new when the row vanished mid-refresh (opt-out race)', async () => {
    const requestedAt = new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString();
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(pendingRow(requestedAt))
      .mockResolvedValueOnce(null);
    mockedDb.refreshWatchRequest.mockResolvedValue(false);

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(200);
    expect(mockedDb.createWatchRequest).toHaveBeenCalledTimes(1);
    expect(mockedDb.enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it('compensates a fresh row when the enqueue fails (500, no dead end)', async () => {
    mockedDb.enqueueEvent.mockRejectedValue(new Error('turso down'));
    // Branch read: no row yet (create path); compensation re-read: the
    // just-written fresh pending row.
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pendingRow(new Date().toISOString()));
    mockedDb.hasOpenInviteEvent.mockResolvedValue(false);
    mockedDb.deactivateWatch.mockResolvedValue(true);

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(500);
    // Fresh pending row with no open invite: rolled back so the next
    // signup can start over instead of sitting cooldown-blocked.
    expect(mockedDb.deactivateWatch).toHaveBeenCalledWith(STEAM_ID);
  });

  it('skips compensation when someone else queued meanwhile (500, row kept)', async () => {
    mockedDb.enqueueEvent.mockRejectedValue(new Error('turso down'));
    mockedDb.getWatchedProfile
      .mockResolvedValueOnce(null)
      .mockResolvedValue(pendingRow(new Date().toISOString()));
    mockedDb.hasOpenInviteEvent.mockResolvedValue(true);

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(500);
    expect(mockedDb.deactivateWatch).not.toHaveBeenCalled();
  });

  it('rejects a client-supplied steamId (identity is session-only)', async () => {
    const res = await POST(
      makeRequest({ jsonBody: { steamId: STEAM_ID, locale: 'pt' } }),
    );

    expect(res.status).toBe(400);
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('returns 401 without a login session (never touches the DAL)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(401);
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('returns 403 for cross-origin POSTs and 429 when limited', async () => {
    const forbidden = await POST(makeRequest({ jsonBody: {}, origin: 'https://evil.example' }));
    expect(forbidden.status).toBe(403);

    __testIsRateLimited.mockReturnValue(true);
    const limited = await POST(makeRequest({ jsonBody: {} }));
    expect(limited.status).toBe(429);
    expect(mockedDb.createAccount).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL throws (session id is public, safe to log)', async () => {
    mockedDb.createAccount.mockRejectedValue(new Error('db down'));

    const res = await POST(makeRequest({ jsonBody: {} }));

    expect(res.status).toBe(500);
  });

  it('rejects non-POST methods and malformed JSON', async () => {
    expect(await POST(makeRequest({ method: 'GET' }))).toMatchObject({
      status: 405,
    });
    expect(
      await POST(makeRequest({ jsonError: new SyntaxError('bad json') })),
    ).toMatchObject({ status: 400 });
  });
});
