/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  recordLoginFunnelEvent: jest.fn(),
  recordLoginPopupEvent: jest.fn(),
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

const { recordLoginFunnelEvent, recordLoginPopupEvent } = jest.requireMock(
  '@/lib/analytics/db',
) as {
  recordLoginFunnelEvent: jest.Mock;
  recordLoginPopupEvent: jest.Mock;
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
    recordLoginPopupEvent.mockResolvedValue(undefined);
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
    expect(recordLoginPopupEvent).not.toHaveBeenCalled();
  });

  it('routes popup shown to the popup table (never the navbar funnel)', async () => {
    const res = await POST(
      makeRequest({
        jsonBody: {
          event: 'login_popup_shown',
          sessionId: 's1',
          searchId: 'search-1',
        },
      }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordLoginPopupEvent).toHaveBeenCalledTimes(1);
    expect(recordLoginPopupEvent).toHaveBeenCalledWith({
      event: 'login_popup_shown',
      sessionId: 's1',
      searchId: 'search-1',
    });
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });

  it('routes popup CTA clicks to the popup table (navbar metric stays pure)', async () => {
    const res = await POST(
      makeRequest({
        jsonBody: { event: 'login_popup_cta_clicked', sessionId: 's1' },
      }),
    );

    expect(res.status).toBe(200);
    expect(recordLoginPopupEvent).toHaveBeenCalledWith({
      event: 'login_popup_cta_clicked',
      sessionId: 's1',
      searchId: null,
    });
    expect(recordLoginFunnelEvent).not.toHaveBeenCalled();
  });

  it('rejects the mid-step events from the browser (callback_hit / waiting_entered are server-side only)', async () => {
    // Pins the explicit allowlist: only login_cta_clicked may come from
    // the client. If the parser is ever refactored to validate against the
    // LoginFunnelEventKind union (or the CHECK list), forged mid-steps
    // would pollute the funnel — this fails first.
    for (const event of ['login_callback_hit', 'login_waiting_entered']) {
      const res = await POST(
        makeRequest({ jsonBody: { event, sessionId: 's1' } }),
      );
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_REQUEST');
    }
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
