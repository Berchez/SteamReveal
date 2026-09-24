/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  getSearchRecords: jest.fn(),
  getWatchDashboardData: jest.fn(),
  getLoginFunnelStats: jest.fn(),
}));

jest.mock('@/lib/logRouteError', () => ({
  __esModule: true,
  default: jest.fn(),
}));

// Factory must not reference outer variables (TDZ: `import { GET }` runs
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

const { getSearchRecords, getWatchDashboardData, getLoginFunnelStats } =
  jest.requireMock('@/lib/analytics/db') as {
    getSearchRecords: jest.Mock;
    getWatchDashboardData: jest.Mock;
    getLoginFunnelStats: jest.Mock;
  };

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const logRouteErrorMock = jest.requireMock('@/lib/logRouteError').default as jest.Mock;

const makeRequest = (url: string, headers?: Record<string, string>) => ({
  url: `http://localhost${url}`,
  headers: new Headers(headers),
} as Request);

// process.env.NODE_ENV is typed readonly; the route reads it at call time.
const setNodeEnv = (value: string) => {
  (process.env as Record<string, string>).NODE_ENV = value;
};

const SAMPLE_RECORD = {
  id: '1788564056404-tzx2nt',
  searchedAt: '2026-09-04T20:00:00.000Z',
  profile: { steamId: '76561198000000000', nickname: 'Alice' },
  friends: [],
};

describe('GET /api/analytics/dashboard', () => {
  const originalEnv = process.env;
  let originalDbUrl: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    // clearAllMocks only clears call history, not implementations — reset the
    // limiter to "open" so a persistent mockReturnValue can't leak across tests.
    __testIsRateLimited.mockReturnValue(false);
    getSearchRecords.mockResolvedValue([SAMPLE_RECORD]);
    getWatchDashboardData.mockResolvedValue({
      accounts: [],
      watched: [],
      events: [],
      liveness: null,
      generatedAt: '2026-09-19T00:00:00.000Z',
    });
    getLoginFunnelStats.mockResolvedValue({
      ctaEvents: 0,
      ctaSessions: 0,
      completions: 0,
      completedSessions: 0,
      unattributedCompletions: 0,
      conversionRate: null,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });
    originalDbUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
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

  it('returns the rendered dashboard when the key matches via query string', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(html).toContain('<script type="application/json" id="db">');
    expect(html).toContain('76561198000000000');
    expect(getSearchRecords).toHaveBeenCalledTimes(1);
  });

  it('accepts the key via the x-analytics-key header (no secret in the URL)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    const res = await GET(
      makeRequest('/api/analytics/dashboard', { 'x-analytics-key': 'secret' }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Alice');
    expect(getSearchRecords).toHaveBeenCalledTimes(1);
  });

  it('prefers the x-analytics-key header over ?key= when both differ', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';

    // Correct header + wrong query → header wins.
    const accepted = await GET(
      makeRequest('/api/analytics/dashboard?key=wrong', { 'x-analytics-key': 'secret' }),
    );
    expect(accepted.status).toBe(200);
    expect(getSearchRecords).toHaveBeenCalledTimes(1);

    // Wrong header + correct query → the wrong header wins (401), so the
    // header form is authoritative and ?key= can't override a bad header.
    const rejected = await GET(
      makeRequest('/api/analytics/dashboard?key=secret', { 'x-analytics-key': 'wrong' }),
    );
    expect(rejected.status).toBe(401);
    expect(getSearchRecords).toHaveBeenCalledTimes(1);
  });

  it('rejects wrong or missing keys with 401', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    expect((await GET(makeRequest('/api/analytics/dashboard'))).status).toBe(401);
    expect((await GET(makeRequest('/api/analytics/dashboard?key=wrong'))).status).toBe(401);
    expect(
      (
        await GET(makeRequest('/api/analytics/dashboard', { 'x-analytics-key': 'wrong' }))
      ).status,
    ).toBe(401);
    expect(getSearchRecords).not.toHaveBeenCalled();
  });

  it('rate-limits auth attempts (429) even with the correct key', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));

    expect(res.status).toBe(429);
    expect(getSearchRecords).not.toHaveBeenCalled();
    expect(__testIsRateLimited).toHaveBeenCalledWith('test-ip');
  });

  it('stays open when ANALYTICS_DASHBOARD_PASSWORD is not set (local dev only)', async () => {
    delete process.env.ANALYTICS_DASHBOARD_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    setNodeEnv('development');
    const res = await GET(makeRequest('/api/analytics/dashboard'));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Alice');
  });

  it('fails closed in production when ANALYTICS_DASHBOARD_PASSWORD is not set (any host)', async () => {
    delete process.env.ANALYTICS_DASHBOARD_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    setNodeEnv('production');
    const res = await GET(makeRequest('/api/analytics/dashboard'));
    expect(res.status).toBe(503);
    expect(getSearchRecords).not.toHaveBeenCalled();
  });

  it('fails closed when NODE_ENV is unset (misconfigured self-hosted deploy)', async () => {
    delete process.env.ANALYTICS_DASHBOARD_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = '';
    const res = await GET(makeRequest('/api/analytics/dashboard'));
    expect(res.status).toBe(503);
    expect(getSearchRecords).not.toHaveBeenCalled();
  });

  it('returns 503 when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('DATABASE_URL');
    expect(getSearchRecords).not.toHaveBeenCalled();
  });

  it('returns 500 when the read fails', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getSearchRecords.mockRejectedValue(new Error('db down'));
    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    expect(res.status).toBe(500);
  });

  it('embeds the watch aggregates in a second JSON block', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getWatchDashboardData.mockResolvedValue({
      accounts: [
        {
          createdAt: '2026-09-01T00:00:00.000Z',
          confirmedAt: null,
          locale: 'pt',
        },
      ],
      watched: [],
      events: [],
      liveness: null,
      generatedAt: '2026-09-19T00:00:00.000Z',
    });

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(getWatchDashboardData).toHaveBeenCalledTimes(1);
  });

  it('still renders searches when the watch reads fail (fail-open section)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getWatchDashboardData.mockRejectedValue(new Error('watch tables down'));

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    // Searches render normally; the watch block degrades to null (the
    // client shows "unavailable" states instead of breaking the page).
    expect(res.status).toBe(200);
    expect(html).toContain('76561198000000000');
    expect(html).toContain('<script type="application/json" id="watch-db">');
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:watch',
      expect.anything(),
    );
  });

  it('still renders searches when the watch half times out (same fail-open path)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getWatchDashboardData.mockRejectedValue(
      Object.assign(
        new Error('watch dashboard timed out after 4000ms'),
        { name: 'SteamCallTimeoutError' },
      ),
    );

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toMatch(/id="watch-db">\s*null\s*<\/script>/);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:watch',
      expect.anything(),
    );
  });

  it('logs both causes when searches and watch fail together (watch first)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getSearchRecords.mockRejectedValueOnce(new Error('searches down'));
    getWatchDashboardData.mockRejectedValueOnce(new Error('watch down'));

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));

    expect(res.status).toBe(500);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:watch',
      expect.anything(),
    );
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard',
      expect.anything(),
    );
  });

  it('embeds the login-funnel aggregates in a third JSON block', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getLoginFunnelStats.mockResolvedValue({
      ctaEvents: 300,
      ctaSessions: 250,
      completions: 1,
      completedSessions: 1,
      unattributedCompletions: 0,
      conversionRate: 0.4,
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<script type="application/json" id="login-funnel-db">');
    expect(html).toContain('"ctaEvents": 300');
    expect(html).toContain('Steam login funnel');
    expect(getLoginFunnelStats).toHaveBeenCalledTimes(1);
  });

  it('still renders searches when the funnel reads fail (fail-open section)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getLoginFunnelStats.mockRejectedValue(new Error('funnel table down'));

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('76561198000000000');
    expect(html).toContain('<script type="application/json" id="login-funnel-db">');
    expect(html).toMatch(/id="login-funnel-db">\s*null\s*<\/script>/);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:loginFunnel',
      expect.anything(),
    );
  });
});