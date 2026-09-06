/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  attachCheaterProbability: jest.fn(),
}));

// Factory must not reference outer variables (TDZ: `import { POST }` runs
// before module-body consts). Expose the limiter's isRateLimited through the
// mocked module so the 429 test can flip it.
jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const { attachCheaterProbability } = jest.requireMock('@/lib/analytics/db') as {
  attachCheaterProbability: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const makeRequest = (overrides: {
  skipHeader?: string | null;
  jsonBody?: unknown;
} = {}) => {
  const { skipHeader = null, jsonBody = {} } = overrides;
  return {
    method: 'POST',
    headers: {
      get: jest.fn((name: string) =>
        name === 'x-analytics-skip-password' ? skipHeader : null,
      ),
    },
    json: jest.fn().mockResolvedValue(jsonBody),
  } as any;
};

describe('POST /api/recordAnalyticsCheater', () => {
  const originalEnv = process.env;
  let originalDbUrl: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks only clears call history, not implementations — reset the
    // limiter to "open" so a persistent mockReturnValue (exempt-skip test)
    // can't leak into the next test.
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

  it('skips if the skip header matches the password', async () => {
    const res = await POST(makeRequest({ skipHeader: 'test-password' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(attachCheaterProbability).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the per-IP write rate limit is hit', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(
      makeRequest({ jsonBody: { searchId: 'x', score: 10 } }),
    );

    expect(res.status).toBe(429);
    expect(attachCheaterProbability).not.toHaveBeenCalled();
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('exempts a valid skip header from the rate limit (owner calls do no writes)', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await POST(makeRequest({ skipHeader: 'test-password' }));

    expect(res.status).toBe(200);
    expect(__testIsRateLimited).not.toHaveBeenCalled();
    expect(attachCheaterProbability).not.toHaveBeenCalled();
  });

  it('still rate-limits an invalid skip password (brute-force throttle kept)', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ skipHeader: 'wrong-password' }));

    expect(res.status).toBe(429);
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('skips without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    const res = await POST(
      makeRequest({ jsonBody: { searchId: 'x', score: 10 } }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
  });

  it('attaches the cheater score directly into Turso', async () => {
    attachCheaterProbability.mockResolvedValue(true);

    const res = await POST(
      makeRequest({
        jsonBody: { searchId: 'abc-123', score: 42, bannedFriendsCount: 2 },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(attachCheaterProbability).toHaveBeenCalledWith(
      'abc-123',
      expect.objectContaining({ score: 42, bannedFriendsCount: 2 }),
    );
  });

  it('returns 404 when the searchId was not found', async () => {
    attachCheaterProbability.mockResolvedValue(false);
    const res = await POST(makeRequest({ jsonBody: { searchId: 'nope', score: 10 } }));
    expect(res.status).toBe(404);
  });

  it('returns 400 when searchId or score is missing', async () => {
    const res = await POST(makeRequest({ jsonBody: { score: 10 } }));
    expect(res.status).toBe(400);
  });
});