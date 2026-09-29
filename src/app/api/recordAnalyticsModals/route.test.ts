/**
 * @jest-environment node
 */

import { POST } from './route';

jest.mock('@/lib/analytics/db', () => ({
  recordModalEvent: jest.fn(),
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

const { recordModalEvent } = jest.requireMock('@/lib/analytics/db') as {
  recordModalEvent: jest.Mock;
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

const VALID_MODAL = {
  modal: 'sponsor',
  event: 'shown',
};

describe('POST /api/recordAnalyticsModals', () => {
  let originalDbUrl: string | undefined;
  let originalSkipPassword: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks only clears call history, not implementations — reset the
    // limiter to "open" so a persistent mockReturnValue can't leak across tests.
    __testIsRateLimited.mockReturnValue(false);
    recordModalEvent.mockResolvedValue(undefined);
    originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    originalSkipPassword = process.env.ANALYTICS_SKIP_PASSWORD;
    process.env.ANALYTICS_SKIP_PASSWORD = 'test-password';
  });

  afterEach(() => {
    if (originalDbUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDbUrl;
    }
    if (originalSkipPassword === undefined) {
      delete process.env.ANALYTICS_SKIP_PASSWORD;
    } else {
      process.env.ANALYTICS_SKIP_PASSWORD = originalSkipPassword;
    }
  });

  it('records a valid modal event', async () => {
    const res = await POST(makeRequest({ jsonBody: VALID_MODAL }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordModalEvent).toHaveBeenCalledTimes(1);
    expect(recordModalEvent).toHaveBeenCalledWith({
      modal: 'sponsor',
      event: 'shown',
    });
  });

  it('rejects unknown modals and events (allowlist, not blocklist)', async () => {
    for (const jsonBody of [
      { modal: 'donate', event: 'shown' },
      { modal: 'sponsor', event: 'hovered' },
      { modal: 'sponsor' },
      { event: 'shown' },
    ]) {
      const res = await POST(makeRequest({ jsonBody }));
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe('INVALID_REQUEST');
    }
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const res = await POST({
      ...makeRequest({ jsonBody: VALID_MODAL }),
      method: 'GET',
    } as any);

    expect(res.status).toBe(405);
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('skips if the skip header matches the password', async () => {
    const res = await POST(
      makeRequest({ skipHeader: 'test-password', jsonBody: VALID_MODAL }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('rejects with 429 when the per-IP write rate limit is hit', async () => {
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await POST(makeRequest({ jsonBody: VALID_MODAL }));

    expect(res.status).toBe(429);
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('skips (does not 500) without DATABASE_URL', async () => {
    delete process.env.DATABASE_URL;

    const res = await POST(makeRequest({ jsonBody: VALID_MODAL }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ skipped: true });
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('rejects malformed JSON with 400 (never 500s on a bad body)', async () => {
    const res = await POST({
      method: 'POST',
      headers: { get: jest.fn(() => null) },
      json: jest.fn().mockRejectedValue(new SyntaxError('bad json')),
    } as any);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(recordModalEvent).not.toHaveBeenCalled();
  });

  it('fails loud (500) when the DAL write fails', async () => {
    recordModalEvent.mockRejectedValueOnce(new Error('turso down'));

    const res = await POST(makeRequest({ jsonBody: VALID_MODAL }));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
  });

  it('ignores a wrong skip password (falls through to the limiter, still records)', async () => {
    const res = await POST(
      makeRequest({ skipHeader: 'wrong-password', jsonBody: VALID_MODAL }),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ ok: true });
    expect(recordModalEvent).toHaveBeenCalledTimes(1);
  });
});
