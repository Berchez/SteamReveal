/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  attachFriendGcNames: jest.fn(),
}));

jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const { attachFriendGcNames } = jest.requireMock('@/lib/analytics/db') as {
  attachFriendGcNames: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const makeRequest = (
  overrides: {
    skipHeader?: string | null;
    jsonBody?: unknown;
    jsonError?: Error;
  } = {},
) => {
  const { skipHeader = null, jsonBody = {}, jsonError } = overrides;
  return {
    method: 'POST',
    headers: {
      get: jest.fn((name: string) =>
        name === 'x-analytics-skip-password' ? skipHeader : null,
      ),
    },
    json: jest.fn(() =>
      jsonError ? Promise.reject(jsonError) : Promise.resolve(jsonBody),
    ),
  } as any;
};

describe('POST /api/recordAnalyticsFriends', () => {
  const originalEnv = process.env;
  let originalDbUrl: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.ANALYTICS_SKIP_PASSWORD = 'test-password';
  });

  afterEach(() => {
    if (originalDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDbUrl;
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('skips the backfill if the skip header matches the password', async () => {
    const res = await POST(makeRequest({ skipHeader: 'test-password' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(attachFriendGcNames).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the per-IP write rate limit is hit', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest());

    expect(res.status).toBe(429);
    expect(attachFriendGcNames).not.toHaveBeenCalled();
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('exempts a valid skip header from the rate limit', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await POST(makeRequest({ skipHeader: 'test-password' }));

    expect(res.status).toBe(200);
    expect(__testIsRateLimited).not.toHaveBeenCalled();
  });

  it('still rate-limits an invalid skip password (brute-force throttle kept)', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ skipHeader: 'wrong-password' }));

    expect(res.status).toBe(429);
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('skips the backfill without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    const res = await POST(makeRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(attachFriendGcNames).not.toHaveBeenCalled();
  });

  it('treats an empty gcNames batch as a successful no-op', async () => {
    const res = await POST(
      makeRequest({ jsonBody: { searchId: 'search-1', gcNames: [] } }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, updated: 0 });
    expect(attachFriendGcNames).not.toHaveBeenCalled();
  });

  it('writes valid names through the DAL and reports the updated count', async () => {
    attachFriendGcNames.mockResolvedValue({ searchExists: true, updated: 2 });

    const res = await POST(
      makeRequest({
        jsonBody: {
          searchId: 'search-1',
          gcNames: [
            { steamId: '76561198000000001', gcName: 'Alice' },
            { steamId: '76561198000000002', gcName: 'Bob' },
          ],
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, updated: 2 });
    expect(attachFriendGcNames).toHaveBeenCalledWith(
      'search-1',
      expect.arrayContaining([
        { steamId: '76561198000000001', gcName: 'Alice' },
        { steamId: '76561198000000002', gcName: 'Bob' },
      ]),
    );
  });

  it('returns 404 when the search record does not exist', async () => {
    attachFriendGcNames.mockResolvedValue({ searchExists: false, updated: 0 });

    const res = await POST(
      makeRequest({
        jsonBody: {
          searchId: 'no-such-search',
          gcNames: [{ steamId: '76561198000000001', gcName: 'Alice' }],
        },
      }),
    );

    expect(res.status).toBe(404);
  });

  it('returns 400 when the body is invalid', async () => {
    const res = await POST(makeRequest({ jsonBody: { gcNames: [] } }));

    expect(res.status).toBe(400);
    expect(attachFriendGcNames).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeRequest({ jsonError: new SyntaxError('bad') }));

    expect(res.status).toBe(400);
  });

  it('returns 500 when the Turso write fails', async () => {
    attachFriendGcNames.mockRejectedValue(new Error('db down'));

    const res = await POST(
      makeRequest({
        jsonBody: {
          searchId: 'search-1',
          gcNames: [{ steamId: '76561198000000001', gcName: 'Alice' }],
        },
      }),
    );

    expect(res.status).toBe(500);
  });
});
