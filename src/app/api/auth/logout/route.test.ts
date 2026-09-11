/**
 * @jest-environment node
 */

import { POST } from './route';

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
  destroyWatchSession: jest.fn(),
}));

const { cookies } = jest.requireMock('next/headers') as {
  cookies: jest.Mock;
};
const { destroyWatchSession } = jest.requireMock('@/lib/watch/session') as {
  destroyWatchSession: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const BASE = 'http://localhost:3000';
const URL = `${BASE}/api/auth/logout`;

const postRequest = (origin?: string) =>
  new Request(URL, {
    method: 'POST',
    headers: origin ? { origin } : {},
  });

describe('POST /api/auth/logout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    cookies.mockReturnValue({});
    destroyWatchSession.mockResolvedValue(undefined);
  });

  it('destroys the session for same-origin callers', async () => {
    const res = await POST(postRequest(BASE));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(destroyWatchSession).toHaveBeenCalledTimes(1);
  });

  it('rejects cross-origin and origin-less POSTs (CSRF fail-closed)', async () => {
    for (const req of [postRequest('https://evil.example'), postRequest()]) {
      const res = await POST(req);
      expect(res.status).toBe(403);
    }
    expect(destroyWatchSession).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const res = await POST(new Request(URL, { method: 'GET' }));
    expect(res.status).toBe(405);
  });

  it('returns 429 when rate limited', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await POST(postRequest(BASE));

    expect(res.status).toBe(429);
    expect(destroyWatchSession).not.toHaveBeenCalled();
  });

  it('returns 500 when the destroy fails', async () => {
    destroyWatchSession.mockRejectedValueOnce(new Error('db down'));
    const res = await POST(postRequest(BASE));
    expect(res.status).toBe(500);
  });
});
