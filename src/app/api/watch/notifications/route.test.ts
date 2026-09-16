/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  listProfileSearches: jest.fn(),
  countSearchesSince: jest.fn(),
  countSearchesInMonth: jest.fn(),
  getWatchedProfile: jest.fn(),
}));

// Same per-file limiter trick as the sibling route tests: the factory runs
// once, so expose isRateLimited for the 429 test to flip.
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

const {
  listProfileSearches,
  countSearchesSince,
  countSearchesInMonth,
  getWatchedProfile,
} = jest.requireMock('@/lib/analytics/db') as {
  listProfileSearches: jest.Mock;
  countSearchesSince: jest.Mock;
  countSearchesInMonth: jest.Mock;
  getWatchedProfile: jest.Mock;
};

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const makeRequest = (url: string) =>
  ({
    method: 'GET',
    url,
  }) as unknown as Request;

const STEAM_ID = '76561198000000001';
const BASE = 'http://localhost/api/watch/notifications';

// Default watch row: active since Feb, requested in Jan — every read test
// below exercises the floored path unless it overrides this.
const ACTIVE_ROW = {
  steamId: STEAM_ID,
  status: 'active',
  locale: null,
  requestedAt: '2026-01-01T00:00:00.000Z',
  activatedAt: '2026-02-01T00:00:00.000Z',
  lastNotifiedAt: null,
};
const WATCH_FLOOR = '2026-02-01T00:00:00.000Z';

describe('GET /api/watch/notifications', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    listProfileSearches.mockResolvedValue([]);
    countSearchesSince.mockResolvedValue(0);
    countSearchesInMonth.mockResolvedValue(0);
    getWatchedProfile.mockResolvedValue(ACTIVE_ROW);
  });

  it('returns recorded searches newest-first for the session user', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-9',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
      {
        searchId: 'search-7',
        searchedAt: '2026-06-01T00:00:00.000Z',
        cheaterChecked: true,
      },
    ]);
    countSearchesSince.mockResolvedValue(2);
    countSearchesInMonth.mockResolvedValue(11);

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [
        {
          searchId: 'search-9',
          searchedAt: '2026-06-02T00:00:00.000Z',
          cheaterChecked: false,
        },
        {
          searchId: 'search-7',
          searchedAt: '2026-06-01T00:00:00.000Z',
          cheaterChecked: true,
        },
      ],
      unreadCount: 2,
      monthlyCount: 11,
    });
    expect(listProfileSearches).toHaveBeenCalledWith(
      STEAM_ID,
      20,
      WATCH_FLOOR,
    );
    // No watermark sent: count from null (never opened) — but the watch
    // floor still applies.
    expect(countSearchesSince).toHaveBeenCalledWith(
      STEAM_ID,
      null,
      WATCH_FLOOR,
    );
    expect(countSearchesInMonth).toHaveBeenCalledWith(
      STEAM_ID,
      expect.any(Number),
      WATCH_FLOOR,
    );
  });

  it('returns 401 without a login session (never touches the DAL)', async () => {
    resolveWatchSession.mockResolvedValue({ status: 'unauthenticated' });

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body).toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'UNAUTHENTICATED' }),
      }),
    );
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesSince).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
    expect(getWatchedProfile).not.toHaveBeenCalled();
  });

  it('forwards a valid limit and clamps an oversized one', async () => {
    await GET(makeRequest(`${BASE}?limit=5`));
    expect(listProfileSearches).toHaveBeenCalledWith(STEAM_ID, 5, WATCH_FLOOR);

    await GET(makeRequest(`${BASE}?limit=500`));
    expect(listProfileSearches).toHaveBeenCalledWith(STEAM_ID, 50, WATCH_FLOOR);
  });

  it('rejects any ?steamId= and invalid limit without touching the DAL', async () => {
    for (const url of [
      `${BASE}?steamId=${STEAM_ID}`,
      `${BASE}?steamId=nope`,
      `${BASE}?limit=0`,
      `${BASE}?limit=abc`,
      `${BASE}?limit=2.5`,
      `${BASE}?sinceSearchedAt=nope`,
      `${BASE}?sinceSearchedAt=`,
      `${BASE}?sinceSentAt=nope`,
      `${BASE}?sinceSentAt=`,
    ]) {
      const res = await GET(makeRequest(url));
      expect(res.status).toBe(400);
    }
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesSince).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
    expect(getWatchedProfile).not.toHaveBeenCalled();
  });

  it('passes the client watermark through to the count', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-30',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
    ]);
    countSearchesSince.mockResolvedValue(5);

    const res = await GET(
      makeRequest(`${BASE}?sinceSearchedAt=2026-06-01T00:00:00.000Z`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [
        {
          searchId: 'search-30',
          searchedAt: '2026-06-02T00:00:00.000Z',
          cheaterChecked: false,
        },
      ],
      unreadCount: 5,
      monthlyCount: 0,
    });
    expect(countSearchesSince).toHaveBeenCalledWith(
      STEAM_ID,
      '2026-06-01T00:00:00.000Z',
      WATCH_FLOOR,
    );
  });

  it('accepts the legacy sinceSentAt alias (pre-split watermarks)', async () => {
    countSearchesSince.mockResolvedValue(3);

    const res = await GET(
      makeRequest(`${BASE}?sinceSentAt=2026-06-01T00:00:00.000Z`),
    );

    expect(res.status).toBe(200);
    expect(countSearchesSince).toHaveBeenCalledWith(
      STEAM_ID,
      '2026-06-01T00:00:00.000Z',
      WATCH_FLOOR,
    );
  });

  it('prefers sinceSearchedAt when both params travel', async () => {
    countSearchesSince.mockResolvedValue(1);

    const res = await GET(
      makeRequest(
        `${BASE}?sinceSearchedAt=2026-06-02T00:00:00.000Z&sinceSentAt=2026-06-01T00:00:00.000Z`,
      ),
    );

    expect(res.status).toBe(200);
    expect(countSearchesSince).toHaveBeenCalledWith(
      STEAM_ID,
      '2026-06-02T00:00:00.000Z',
      WATCH_FLOOR,
    );
  });

  it('floors every read at the watch activation (no pre-watch history leaks)', async () => {
    getWatchedProfile.mockResolvedValue({
      steamId: STEAM_ID,
      status: 'active',
      locale: null,
      requestedAt: '2026-05-01T00:00:00.000Z',
      activatedAt: '2026-06-01T12:00:00.000Z',
      lastNotifiedAt: null,
    });

    const res = await GET(makeRequest(BASE));

    expect(res.status).toBe(200);
    expect(getWatchedProfile).toHaveBeenCalledWith(STEAM_ID);
    expect(listProfileSearches).toHaveBeenCalledWith(
      STEAM_ID,
      20,
      '2026-06-01T12:00:00.000Z',
    );
    expect(countSearchesSince).toHaveBeenCalledWith(
      STEAM_ID,
      null,
      '2026-06-01T12:00:00.000Z',
    );
    expect(countSearchesInMonth).toHaveBeenCalledWith(
      STEAM_ID,
      expect.any(Number),
      '2026-06-01T12:00:00.000Z',
    );
  });

  it('falls back to requested_at while the watch is still pending', async () => {
    getWatchedProfile.mockResolvedValue({
      steamId: STEAM_ID,
      status: 'pending',
      locale: null,
      requestedAt: '2026-06-01T00:00:00.000Z',
      activatedAt: null,
      lastNotifiedAt: null,
    });

    const res = await GET(makeRequest(BASE));

    expect(res.status).toBe(200);
    expect(listProfileSearches).toHaveBeenCalledWith(
      STEAM_ID,
      20,
      '2026-06-01T00:00:00.000Z',
    );
  });

  it('returns an empty inbox without touching search reads when no watch was ever requested', async () => {
    // searches is shared site analytics: answering from it here would
    // leak the profile's whole lookup history to someone who never
    // opted in — so the route short-circuits before any search read.
    getWatchedProfile.mockResolvedValue(null);

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [],
      unreadCount: 0,
      monthlyCount: 0,
    });
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesSince).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
  });

  it('stays empty after opt-out deleted the watch row (no post-exit leak)', async () => {
    // Opt-out deletes the watched_profiles row, so a logged-in
    // post-opt-out profile reads exactly like a never-requested one:
    // empty inbox, no search-table access. Without this, leaving would
    // perversely EXPOSE more history (unfiltered) than staying watched.
    getWatchedProfile.mockResolvedValue(null);

    const res = await GET(
      makeRequest(`${BASE}?sinceSearchedAt=2026-01-01T00:00:00.000Z`),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      steamId: STEAM_ID,
      notifications: [],
      unreadCount: 0,
      monthlyCount: 0,
    });
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesSince).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
  });

  it('rejects non-GET methods and rate-limited callers', async () => {
    const res = await GET({
      method: 'POST',
      url: BASE,
    } as unknown as Request);
    expect(res.status).toBe(405);

    __testIsRateLimited.mockReturnValueOnce(true);
    const limited = await GET(makeRequest(BASE));
    expect(limited.status).toBe(429);
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
  });

  it('returns 500 when the DAL fails (no stack traces leak)', async () => {
    listProfileSearches.mockRejectedValue(new Error('db down'));
    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(String(JSON.stringify(body))).not.toContain('db down');
  });

  it('returns 500 when the session layer blows up (loud, not silent)', async () => {
    resolveWatchSession.mockResolvedValue({
      status: 'error',
      error: new Error('SESSION_SECRET exploded'),
    });

    const res = await GET(makeRequest(BASE));

    expect(res.status).toBe(500);
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
  });
});
