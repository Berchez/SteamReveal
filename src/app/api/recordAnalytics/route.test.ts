/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  recordSearch: jest.fn(),
}));

// Factory must not reference outer variables (TDZ: `import { POST }` runs
// before module-body consts). Expose the limiter's isRateLimited through the
// mocked module so the 429 test can flip it. Same trick works for resetting
// between tests because the module registry is per-file and the factory runs
// once, at first require.
jest.mock('@/lib/rateLimit', () => {
  const isRateLimited = jest.fn(() => false);
  return {
    createRateLimiter: jest.fn().mockReturnValue({ isRateLimited }),
    getRequestIp: jest.fn(() => 'test-ip'),
    __testIsRateLimited: isRateLimited,
  };
});

const { recordSearch } = jest.requireMock('@/lib/analytics/db') as {
  recordSearch: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const makeRequest = (overrides: {
  skipHeader?: string | null;
  jsonBody?: unknown;
  jsonError?: Error;
} = {}) => {
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

describe('POST /api/recordAnalytics', () => {
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

  it('skips recording if the skip header matches the password', async () => {
    const res = await POST(makeRequest({ skipHeader: 'test-password' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: null, skipped: true });
    expect(recordSearch).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the per-IP write rate limit is hit', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ jsonBody: { profile: { steamId: '76561198000000000' } } }));

    expect(res.status).toBe(429);
    expect(recordSearch).not.toHaveBeenCalled();
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('exempts a valid skip header from the rate limit (owner calls do no writes)', async () => {
    __testIsRateLimited.mockReturnValue(true);

    const res = await POST(makeRequest({ skipHeader: 'test-password' }));

    expect(res.status).toBe(200);
    expect(__testIsRateLimited).not.toHaveBeenCalled();
    expect(recordSearch).not.toHaveBeenCalled();
  });

  it('still rate-limits an invalid skip password (brute-force throttle kept)', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ skipHeader: 'wrong-password' }));

    expect(res.status).toBe(429);
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('skips recording without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;
    const res = await POST(makeRequest({ jsonBody: { profile: { steamId: '76561198000000000' } } }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ id: null, skipped: true });
    expect(recordSearch).not.toHaveBeenCalled();
  });

  it('records a valid payload directly into Turso', async () => {
    recordSearch.mockResolvedValue({ id: 'unittest-id' });

    const res = await POST(
      makeRequest({
        jsonBody: {
          profile: { steamId: '76561198000000000', nickname: 'Alice' },
          friends: [],
          device: 'desktop',
          durationMs: 900,
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true, id: 'unittest-id' });
    expect(recordSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        profile: expect.objectContaining({ steamId: '76561198000000000' }),
        device: 'desktop',
        durationMs: 900,
      }),
    );
  });

  it('returns 400 when profile/steamId is missing', async () => {
    const res = await POST(makeRequest({ jsonBody: { profile: {} } }));
    expect(res.status).toBe(400);
    expect(recordSearch).not.toHaveBeenCalled();
  });

  it('returns 400 on malformed JSON', async () => {
    const res = await POST(makeRequest({ jsonError: new SyntaxError('bad') }));
    expect(res.status).toBe(400);
  });

  it('returns 500 when the Turso write fails', async () => {
    recordSearch.mockRejectedValue(new Error('db down'));
    const res = await POST(makeRequest({ jsonBody: { profile: { steamId: '76561198000000000' } } }));
    expect(res.status).toBe(500);
  });
});