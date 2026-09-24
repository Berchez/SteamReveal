/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  recordLoginFunnelEvent: jest.fn(),
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

const { recordLoginFunnelEvent } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  recordLoginFunnelEvent: jest.Mock;
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

const VALID_CTA = {
  event: 'login_cta_clicked',
  sessionId: '550e8400-e29b-41d4-a716-446655440000',
  searchId: '1788564056404-tzx2nt',
};

describe('POST /api/recordAnalyticsLogin', () => {
  const originalEnv = process.env;
  let originalDbUrl: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks only clears call history, not implementations — reset the
    // limiter to "open" so a persistent mockReturnValue can't leak across tests.
    __testIsRateLimited.mockReturnValue(false);
    recordLoginFunnelEvent.mockResolvedValue(undefined);
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

  it('records a valid CTA beacon', async () => {
    const res = await POST(makeRequest({ jsonBody: VALID_CTA }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordLoginFunnelEvent).toHaveBeenCalledTimes(1);
    expect(recordLoginFunnelEvent).toHaveBeenCalledWith({
      event: 'login_cta_clicked',
      sessionId: VALID_CTA.sessionId,
      searchId: VALID_CTA.searchId,
    });
  });

  it('accepts a CTA without searchId (click outside a search)', async () => {
    const res = await POST(
      makeRequest({
        jsonBody: { event: 'login_cta_clicked', sessionId: 's1' },
      }),
    );

    expect(res.status).toBe(200);
    expect(recordLoginFunnelEvent).toHaveBeenCalledWith({
      event: 'login_cta_clicked',
      sessionId: 's1',
      searchId: null,
    });
  });

  it('rejects a forged login_completed (completions are server-side only)', async () => {
    const res = await POST(
      makeRequest({
        jsonBody: {
          event: 'login_completed',
          sessionId: 's1',
          searchId: 'x',
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });

  it('skips if the skip header matches the password', async () => {
    const res = await POST(
      makeRequest({ skipHeader: 'test-password', jsonBody: VALID_CTA }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the per-IP write rate limit is hit', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ jsonBody: VALID_CTA }));

    expect(res.status).toBe(429);
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });

  it('skips (does not 500) without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;

    const res = await POST(makeRequest({ jsonBody: VALID_CTA }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });
});
