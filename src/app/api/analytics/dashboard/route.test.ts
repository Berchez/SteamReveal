/**
 * @jest-environment node
 */

import { GET, maxDuration } from './route';
import { STATS_READ_TIMEOUT_MS } from './dashboardStatsConfig';

// Test-owned policy (not production config): how far below the function
// ceiling the stats budget must stay for the fail-open to fire instead of
// a platform 504.
const STATS_TIMEOUT_SAFETY_MARGIN_MS = 10_000;

// Real DAL constant (this file mocks '@/lib/analytics/db', so the mock
// would hand back whatever the factory claims — requireActual reads the
// value the production code actually enforces).
const { DASHBOARD_STATS_DRIVER_TIMEOUT_MS } = jest.requireActual(
  '@/lib/analytics/db',
) as { DASHBOARD_STATS_DRIVER_TIMEOUT_MS: number };

jest.mock('@/lib/analytics/db', () => ({
  DASHBOARD_HISTORY_LIMIT: 500,
  DASHBOARD_HISTORY_LIMIT_MAX: 1500,
  getDashboardHistory: jest.fn(),
  getDashboardStats: jest.fn(),
  getWatchDashboardData: jest.fn(),
  getLoginFunnelStats: jest.fn(),
  readModalStatsIsolated: jest.fn(),
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

const {
  DASHBOARD_HISTORY_LIMIT,
  getDashboardHistory,
  getDashboardStats,
  getWatchDashboardData,
  getLoginFunnelStats,
  readModalStatsIsolated,
} = jest.requireMock('@/lib/analytics/db') as {
  DASHBOARD_HISTORY_LIMIT: number;
  getDashboardHistory: jest.Mock;
  getDashboardStats: jest.Mock;
  getWatchDashboardData: jest.Mock;
  getLoginFunnelStats: jest.Mock;
  readModalStatsIsolated: jest.Mock;
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
    getDashboardHistory.mockResolvedValue([SAMPLE_RECORD]);
    getDashboardStats.mockResolvedValue({
      summary: {
        totalSearches: 1,
        uniqueProfiles: 1,
        uniqueFriends: 0,
        totalFriends: 0,
        privateListSearches: 0,
        gcMatches: 0,
        avgDurationMs: null,
      },
      searchTimestamps: ['2026-09-04T20:00:00.000Z'],
      localeCounts: {},
      browserLangCounts: {},
      deviceCounts: {},
      countryCounts: {},
      cheaterRows: [],
      games: [],
      totalProfilesForGames: 1,
      csActiveCount: 0,
      locations: [],
      topProfiles: [],
      topFriends: [],
      generatedAt: '2026-09-24T00:00:00.000Z',
    });
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
      callbackSessions: 0,
      steamAbandonSessions: 0,
      waitingSessions: 0,
      waitingLeakSessions: 0,
      completions: 0,
      completedSessions: 0,
      unattributedCompletions: 0,
      conversionRate: null,
      popup: {
        popupShown: 0,
        popupShownSessions: 0,
        popupClicks: 0,
        popupClickSessions: 0,
        popupAttributedSignins: 0,
        popupConversionRate: null,
      },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });
    readModalStatsIsolated.mockResolvedValue({
      sponsor: { shown: 0, ctaClicks: 0, closed: 0, dismissed: 0 },
      support: { shown: 0, ctaClicks: 0, closed: 0, dismissed: 0 },
      loginPrompt: { shown: 0, ctaClicks: 0, closed: 0, dismissed: 0 },
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
    expect(getDashboardHistory).toHaveBeenCalledTimes(1);
    // Bounded window (never the full tables): the route passes the
    // product cap, not an arbitrary number.
    expect(getDashboardHistory).toHaveBeenCalledWith(DASHBOARD_HISTORY_LIMIT);
    expect(getDashboardStats).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['absent (default window)', '', 500],
    ['empty (default window)', '&limit=', 500],
    ['garbage (default window)', '&limit=abc', 500],
    ['Infinity (default window)', '&limit=Infinity', 500],
    ['negative clamps to 1', '&limit=-20', 1],
    ['zero clamps to 1', '&limit=0', 1],
    ['decimal floors', '&limit=12.9', 12],
    ['custom window', '&limit=100', 100],
    ['over the ceiling clamps', '&limit=999999', 1500],
  ])('history window %s', async (_label, extraQuery, expected) => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';

    const res = await GET(
      makeRequest(`/api/analytics/dashboard?key=secret${extraQuery}`),
    );

    expect(res.status).toBe(200);
    expect(getDashboardHistory).toHaveBeenCalledWith(expected);
  });

  it('accepts the key via the x-analytics-key header (no secret in the URL)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    const res = await GET(
      makeRequest('/api/analytics/dashboard', { 'x-analytics-key': 'secret' }),
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('Alice');
    expect(getDashboardHistory).toHaveBeenCalledTimes(1);
  });

  it('prefers the x-analytics-key header over ?key= when both differ', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';

    // Correct header + wrong query → header wins.
    const accepted = await GET(
      makeRequest('/api/analytics/dashboard?key=wrong', { 'x-analytics-key': 'secret' }),
    );
    expect(accepted.status).toBe(200);
    expect(getDashboardHistory).toHaveBeenCalledTimes(1);

    // Wrong header + correct query → the wrong header wins (401), so the
    // header form is authoritative and ?key= can't override a bad header.
    const rejected = await GET(
      makeRequest('/api/analytics/dashboard?key=secret', { 'x-analytics-key': 'wrong' }),
    );
    expect(rejected.status).toBe(401);
    expect(getDashboardHistory).toHaveBeenCalledTimes(1);
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
    expect(getDashboardHistory).not.toHaveBeenCalled();
  });

  it('rate-limits auth attempts (429) even with the correct key', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    __testIsRateLimited.mockReturnValueOnce(true);

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));

    expect(res.status).toBe(429);
    expect(getDashboardHistory).not.toHaveBeenCalled();
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
    expect(getDashboardHistory).not.toHaveBeenCalled();
  });

  it('fails closed when NODE_ENV is unset (misconfigured self-hosted deploy)', async () => {
    delete process.env.ANALYTICS_DASHBOARD_PASSWORD;
    delete process.env.VERCEL;
    delete process.env.VERCEL_ENV;
    (process.env as Record<string, string>).NODE_ENV = '';
    const res = await GET(makeRequest('/api/analytics/dashboard'));
    expect(res.status).toBe(503);
    expect(getDashboardHistory).not.toHaveBeenCalled();
  });

  it('returns 503 when DATABASE_URL is not configured', async () => {
    delete process.env.DATABASE_URL;
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    expect(res.status).toBe(503);
    expect(await res.text()).toContain('DATABASE_URL');
    expect(getDashboardHistory).not.toHaveBeenCalled();
  });

  it('returns 500 when the read fails', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getDashboardHistory.mockRejectedValue(new Error('db down'));
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
    getDashboardHistory.mockRejectedValueOnce(new Error('searches down'));
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
      callbackSessions: 200,
      steamAbandonSessions: 50,
      waitingSessions: 120,
      waitingLeakSessions: 118,
      completions: 1,
      completedSessions: 1,
      unattributedCompletions: 0,
      conversionRate: 0.4,
      popup: {
        popupShown: 20,
        popupShownSessions: 15,
        popupClicks: 5,
        popupClickSessions: 4,
        popupAttributedSignins: 1,
        popupConversionRate: 25,
      },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<script type="application/json" id="login-funnel-db">');
    expect(html).toContain('"ctaEvents":300');
    expect(html).toContain('"popupClicks":5');
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

  it('embeds the modal aggregates in a fourth JSON block', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    readModalStatsIsolated.mockResolvedValue({
      sponsor: { shown: 10, ctaClicks: 3, closed: 5, dismissed: 2 },
      support: { shown: 7, ctaClicks: 1, closed: 4, dismissed: 2 },
      loginPrompt: { shown: 12, ctaClicks: 4, closed: 6, dismissed: 1 },
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<script type="application/json" id="modal-stats-db">');
    expect(html).toContain('"ctaClicks":3');
    expect(html).toContain('SponsorMe');
    expect(html).toContain('SupportMe');
    expect(html).toContain('Login prompt');
    expect(readModalStatsIsolated).toHaveBeenCalledTimes(1);
  });

  it('still renders searches when the modal reads fail (fail-open section)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    readModalStatsIsolated.mockRejectedValue(new Error('modal table down'));

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('76561198000000000');
    expect(html).toContain('<script type="application/json" id="modal-stats-db">');
    expect(html).toMatch(/id="modal-stats-db">\s*null\s*<\/script>/);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:modals',
      expect.anything(),
    );
  });

  it('embeds the search-stats aggregates in a fifth JSON block', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getDashboardStats.mockResolvedValue({
      summary: {
        totalSearches: 6231,
        uniqueProfiles: 6000,
        uniqueFriends: 9000,
        totalFriends: 84000,
        privateListSearches: 10,
        gcMatches: 20,
        avgDurationMs: 1500,
      },
      searchTimestamps: [],
      localeCounts: {},
      browserLangCounts: {},
      deviceCounts: {},
      countryCounts: {},
      cheaterRows: [],
      games: [],
      totalProfilesForGames: 6231,
      csActiveCount: 100,
      locations: [],
      topProfiles: [],
      topFriends: [],
      generatedAt: '2026-09-24T00:00:00.000Z',
    });

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('<script type="application/json" id="dashboard-stats-db">');
    expect(html).toContain('"totalSearches":6231');
    expect(getDashboardStats).toHaveBeenCalledTimes(1);
  });

  it('still renders history when the stats read fails (fail-open section)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    getDashboardStats.mockRejectedValue(new Error('stats down'));

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain('76561198000000000');
    expect(html).toContain('<script type="application/json" id="dashboard-stats-db">');
    expect(html).toMatch(/id="dashboard-stats-db">\s*null\s*<\/script>/);
    expect(logRouteErrorMock).toHaveBeenCalledWith(
      'analytics/dashboard:stats',
      expect.anything(),
    );
  });

  it('still renders history when the stats read times out (fail-open on latency, not just errors)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';
    // Never settles: the withTimeout budget from dashboardStatsConfig (not
    // a throw) must trip the same null-stats degradation as a rejection.
    getDashboardStats.mockReturnValue(new Promise(() => {}));
    jest.useFakeTimers();
    try {
      const pending = GET(makeRequest('/api/analytics/dashboard?key=secret'));
      await jest.advanceTimersByTimeAsync(STATS_READ_TIMEOUT_MS);
      const res = await pending;
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(html).toContain('76561198000000000');
      expect(html).toMatch(/id="dashboard-stats-db">\s*null\s*<\/script>/);
      expect(logRouteErrorMock).toHaveBeenCalledWith(
        'analytics/dashboard:stats',
        expect.anything(),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the stats budget a safety margin below maxDuration (fail-open needs a live function)', () => {
    // maxDuration must stay a static literal (Next.js route config), so
    // the coupling is asserted here instead of shared in code: if someone
    // raises STATS_READ_TIMEOUT_MS near the ceiling, the timeout would
    // never fire before the platform 504s the whole page.
    expect(maxDuration * 1000 - STATS_READ_TIMEOUT_MS).toBeGreaterThanOrEqual(
      STATS_TIMEOUT_SAFETY_MARGIN_MS,
    );
    // Full timeout ordering across the two layers: the route fail-open
    // (25s) must fire first, the DAL hang backstop second, and both must
    // fit inside the function ceiling. Reordering any of the three
    // silently breaks the degradation chain, so it is pinned here.
    expect(STATS_READ_TIMEOUT_MS).toBeLessThan(
      DASHBOARD_STATS_DRIVER_TIMEOUT_MS,
    );
    expect(DASHBOARD_STATS_DRIVER_TIMEOUT_MS).toBeLessThan(
      maxDuration * 1000,
    );
  });

  it('sends anti-leak hardening headers on the 200 (bookmarkable ?key= must not escape)', async () => {
    process.env.ANALYTICS_DASHBOARD_PASSWORD = 'secret';

    const res = await GET(makeRequest('/api/analytics/dashboard?key=secret'));

    expect(res.status).toBe(200);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-robots-tag')).toContain('noindex');
  });
});