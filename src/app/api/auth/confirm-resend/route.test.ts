/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  enqueueEvent: jest.fn(),
  getAccount: jest.fn(),
  getWatchedProfile: jest.fn(),
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
  enqueueEvent: jest.Mock;
  getAccount: jest.Mock;
  getWatchedProfile: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';
const BASE = 'http://localhost:3000/api/auth/confirm-resend';
const ORIGIN = 'http://localhost:3000';

const postRequest = (origin: string | null = ORIGIN) => {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  return new Request(BASE, { method: 'POST', headers });
};

describe('POST /api/auth/confirm-resend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    mockedDb.getWatchedProfile.mockResolvedValue({ status: 'pending' });
    mockedDb.getAccount.mockResolvedValue({ confirmedAt: null });
    mockedDb.enqueueEvent.mockResolvedValue({ eventId: 7, duplicate: false });
  });

  it('enqueues a resend request for pending + unconfirmed watches', async () => {
    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, queued: true });
    // The route only REQUESTS — the bot remains the sole token issuer.
    expect(mockedDb.enqueueEvent).toHaveBeenCalledWith(
      STEAM_ID,
      'confirm_resend',
    );
  });

  it('answers queued:false without touching the outbox when nothing is due', async () => {
    // No watch row.
    mockedDb.getWatchedProfile.mockResolvedValue(null);
    const gone = await POST(postRequest());
    expect(await gone.json()).toEqual({ ok: true, queued: false });

    // Active watch (confirmed by construction — no link needed).
    mockedDb.getWatchedProfile.mockResolvedValue({ status: 'active' });
    const active = await POST(postRequest());
    expect(await active.json()).toEqual({ ok: true, queued: false });

    // No account row (legacy/never-signed-up: Start, not resend).
    mockedDb.getWatchedProfile.mockResolvedValue({ status: 'pending' });
    mockedDb.getAccount.mockResolvedValue(null);
    const noAccount = await POST(postRequest());
    expect(await noAccount.json()).toEqual({ ok: true, queued: false });

    // Already confirmed (clicked concurrently — route owns nothing now).
    mockedDb.getAccount.mockResolvedValue({
      confirmedAt: '2026-09-03T00:00:00.000Z',
    });
    const confirmed = await POST(postRequest());
    expect(await confirmed.json()).toEqual({ ok: true, queued: false });

    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('returns 401 without a login session (never touches the DAL)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });

    const res = await POST(postRequest());

    expect(res.status).toBe(401);
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('rejects cross-origin POSTs, wrong methods, and rate-limited callers', async () => {
    const evil = await POST(postRequest('https://evil.example'));
    expect(evil.status).toBe(403);
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();

    const noOrigin = await POST(postRequest(null));
    expect(noOrigin.status).toBe(403);

    const wrongMethod = await POST(
      new Request(BASE, { method: 'DELETE', headers: { origin: ORIGIN } }),
    );
    expect(wrongMethod.status).toBe(405);

    __testIsRateLimited.mockReturnValue(true);
    const limited = await POST(postRequest());
    expect(limited.status).toBe(429);
    expect(mockedDb.enqueueEvent).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL throws (loud, never a fake queued:true)', async () => {
    mockedDb.getWatchedProfile.mockRejectedValue(new Error('db down'));

    const res = await POST(postRequest());

    expect(res.status).toBe(500);
  });

  it('returns 500 when the session layer blows up (loud, not silent)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('SESSION_SECRET exploded'),
    });

    const res = await POST(postRequest());

    expect(res.status).toBe(500);
    expect(mockedDb.getWatchedProfile).not.toHaveBeenCalled();
  });
});
