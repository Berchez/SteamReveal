/**
 * @jest-environment node
 */

import { GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  listProfileSearches: jest.fn(),
  countSearchesSince: jest.fn(),
  countSearchesInMonth: jest.fn(),
  getWatchedProfile: jest.fn(),
  hashAntiLoopToken: jest.fn(),
  issueAntiLoopTokenIfAbsent: jest.fn(),
  ANTI_LOOP_TOKEN_BYTES: 32,
  ANTI_LOOP_TOKEN_TTL_MS: 24 * 60 * 60 * 1000,
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
  hashAntiLoopToken,
  issueAntiLoopTokenIfAbsent,
} = jest.requireMock('@/lib/analytics/db') as {
  listProfileSearches: jest.Mock;
  countSearchesSince: jest.Mock;
  countSearchesInMonth: jest.Mock;
  getWatchedProfile: jest.Mock;
  hashAntiLoopToken: jest.Mock;
  issueAntiLoopTokenIfAbsent: jest.Mock;
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
    // Free token slot by default: withToken fetches mint unless a test
    // overrides. The hash is fixed so issue-call assertions stay exact.
    hashAntiLoopToken.mockReturnValue('test-token-hash');
    issueAntiLoopTokenIfAbsent.mockResolvedValue(true);
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
    // The body carries per-search history (now including searcher
    // country): intermediaries must never cache it, with or without
    // ?withToken=1 — a cached copy could serve one user's history (or a
    // consumed single-use token) to later visitors.
    expect(res.headers.get('cache-control')).toContain('no-store');
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
      // Plain fetch (no ?withToken=1 — badge-only): never mints, even with
      // rows and a free slot.
      antiLoopToken: null,
    });
    expect(issueAntiLoopTokenIfAbsent).not.toHaveBeenCalled();
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

  it('passes the searcher country through to the inbox rows', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-1',
        searchedAt: '2026-06-01T00:00:00.000Z',
        cheaterChecked: false,
        requesterCountry: 'BR',
      },
      {
        searchId: 'search-0',
        searchedAt: '2026-05-01T00:00:00.000Z',
        cheaterChecked: false,
        requesterCountry: null,
      },
    ]);
    countSearchesSince.mockResolvedValue(2);
    countSearchesInMonth.mockResolvedValue(2);

    const res = await GET(makeRequest(BASE));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.notifications).toEqual([
      {
        searchId: 'search-1',
        searchedAt: '2026-06-01T00:00:00.000Z',
        cheaterChecked: false,
        requesterCountry: 'BR',
      },
      {
        searchId: 'search-0',
        searchedAt: '2026-05-01T00:00:00.000Z',
        cheaterChecked: false,
        requesterCountry: null,
      },
    ]);
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
      antiLoopToken: null,
    });
    expect(issueAntiLoopTokenIfAbsent).not.toHaveBeenCalled();
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
      antiLoopToken: null,
    });
    expect(listProfileSearches).not.toHaveBeenCalled();
    expect(countSearchesSince).not.toHaveBeenCalled();
    expect(countSearchesInMonth).not.toHaveBeenCalled();
    expect(issueAntiLoopTokenIfAbsent).not.toHaveBeenCalled();
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
      antiLoopToken: null,
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

  it('mints a fresh token only on link-rendering fetches (?withToken=1)', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-9',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
    ]);

    const res = await GET(makeRequest(`${BASE}?withToken=1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    // Raw single-use token in body: intermediaries must never cache it.
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(body.antiLoopToken).toEqual(
      expect.stringMatching(/^[0-9a-f]{64}$/),
    );
    expect(hashAntiLoopToken).toHaveBeenCalledWith(body.antiLoopToken);
    expect(issueAntiLoopTokenIfAbsent).toHaveBeenCalledWith(
      STEAM_ID,
      'test-token-hash',
      expect.any(String),
    );
  });

  it('hands off an occupied slot atomically (a lost race degrades, never clobbers)', async () => {
    // The bot issued concurrently: the atomic WHERE finds a live token and
    // the UPDATE hits zero rows. The raw chat value is hash-only at rest
    // and unrecoverable, so false here is the whole point — the other
    // link survives, the inbox links stay plain.
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-9',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
    ]);
    issueAntiLoopTokenIfAbsent.mockResolvedValue(false);

    const res = await GET(makeRequest(`${BASE}?withToken=1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.antiLoopToken).toBeNull();
  });

  it('skips minting entirely when there are no rows to link', async () => {
    listProfileSearches.mockResolvedValue([]);

    const res = await GET(makeRequest(`${BASE}?withToken=1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.antiLoopToken).toBeNull();
    expect(issueAntiLoopTokenIfAbsent).not.toHaveBeenCalled();
  });

  it('ignores a malformed withToken instead of 400ing (hint, not contract)', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-9',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
    ]);

    const res = await GET(makeRequest(`${BASE}?withToken=yes`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.antiLoopToken).toBeNull();
    expect(issueAntiLoopTokenIfAbsent).not.toHaveBeenCalled();
  });

  it('degrades to plain links when minting fails (loud fail-open, never a 500)', async () => {
    listProfileSearches.mockResolvedValue([
      {
        searchId: 'search-9',
        searchedAt: '2026-06-02T00:00:00.000Z',
        cheaterChecked: false,
      },
    ]);
    issueAntiLoopTokenIfAbsent.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest(`${BASE}?withToken=1`));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.antiLoopToken).toBeNull();
    expect(body.notifications).toHaveLength(1);
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
