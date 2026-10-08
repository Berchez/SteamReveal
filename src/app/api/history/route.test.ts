/**
 * @jest-environment node
 */

import { DELETE, GET } from './route';

jest.mock('@/lib/analytics/db', () => ({
  deleteSearcherHistory: jest.fn(),
  listSearcherSearches: jest.fn(),
  parseHistoryCursor: jest.fn(),
}));

jest.mock('@/lib/watch/searcherAttribution', () => ({
  hasAccountFootprint: jest.fn(),
}));

jest.mock('@/lib/watch/botProfile', () => ({
  resolveBotProfileUrl: jest.fn(() => 'https://steamcommunity.com/profiles/BOT'),
}));

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
  deleteSearcherHistory,
  listSearcherSearches,
  parseHistoryCursor,
} = jest.requireMock('@/lib/analytics/db') as {
  deleteSearcherHistory: jest.Mock;
  listSearcherSearches: jest.Mock;
  parseHistoryCursor: jest.Mock;
};

const { hasAccountFootprint } = jest.requireMock(
  '@/lib/watch/searcherAttribution',
) as { hasAccountFootprint: jest.Mock };

const { __testIsRateLimited } = jest.requireMock('@/lib/rateLimit') as {
  __testIsRateLimited: jest.Mock;
};

const { resolveWatchSession } = jest.requireMock('@/lib/watch/session') as {
  resolveWatchSession: jest.Mock;
};

const STEAM_ID = '76561198000000001';

const makeRequest = (url: string) =>
  ({
    method: 'GET',
    url: `http://localhost:3000${url}`,
    headers: new Headers(),
  }) as Request;

describe('GET /api/history', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    listSearcherSearches.mockResolvedValue({ entries: [], total: 0 });
    parseHistoryCursor.mockReturnValue(null);
    hasAccountFootprint.mockResolvedValue(true);
  });

  it('returns the viewer-owned window plus the total', async () => {
    listSearcherSearches.mockResolvedValue({
      entries: [
        {
          searchId: 's1',
          searchedAt: '2026-09-30T00:00:00.000Z',
          steamId: '76561198000000002',
          nickname: 'Bob',
          steamUrl: null,
          countryCode: 'BR',
          cheaterChecked: false,
        },
      ],
      total: 7,
      nextCursor: '2026-09-30T00:00:00.000Z|s1',
    });

    const res = await GET(makeRequest('/api/history?limit=10'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.steamId).toBe(STEAM_ID);
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBe(7);
    // Server-built bookmark passes through opaquely (the client never
    // constructs the cursor format).
    expect(body.nextCursor).toBe('2026-09-30T00:00:00.000Z|s1');
    // Live watch footprint: new searches are being attributed.
    expect(body.attributing).toBe(true);
    expect(hasAccountFootprint).toHaveBeenCalledWith(STEAM_ID);
    // Self-scoped: the DAL gets the session id, never a query param — and
    // no cursor on the first page.
    expect(parseHistoryCursor).not.toHaveBeenCalled();
    expect(listSearcherSearches).toHaveBeenCalledWith(STEAM_ID, 10, null);
  });

  it('passes a later page through untouched (null total, opaque bookmark)', async () => {
    parseHistoryCursor.mockReturnValue({
      searchedAt: '2026-09-30T00:00:00.000Z',
      searchId: 's9',
    });
    listSearcherSearches.mockResolvedValue({
      entries: [],
      total: null,
      nextCursor: null,
    });

    const res = await GET(
      makeRequest('/api/history?cursor=2026-09-30T00%3A00%3A00.000Z%7Cs9'),
    );
    const body = await res.json();

    // The route is a dumb pipe for paging shape: total ships on page one
    // only (the client reuses it), exhaustion is the null bookmark.
    // The footprint check runs on the first page only — no PK read per
    // "load more".
    expect(res.status).toBe(200);
    expect(body.total).toBeNull();
    expect(body.nextCursor).toBeNull();
    expect(body.attributing).toBeNull();
    expect(hasAccountFootprint).not.toHaveBeenCalled();
  });

  it('reports attributing:false for a session without a watch footprint (opt-out)', async () => {
    // The modal's empty state needs this to show the truthful "you
    // left" copy instead of promising recordings that never come.
    hasAccountFootprint.mockResolvedValue(false);
    listSearcherSearches.mockResolvedValue({
      entries: [],
      total: 0,
      nextCursor: null,
    });

    const res = await GET(makeRequest('/api/history'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.attributing).toBe(false);
    // Paused first pages also carry the bot-profile link: the reconnect
    // CTA's href (env-derived, public — same URL the login waiting
    // room shows) must not cost the client a second round-trip.
    expect(body.botProfileUrl).toBe(
      'https://steamcommunity.com/profiles/BOT',
    );
  });

  it('omits botProfileUrl while attributing (and on later pages)', async () => {
    hasAccountFootprint.mockResolvedValue(true);
    listSearcherSearches.mockResolvedValue({
      entries: [],
      total: 3,
      nextCursor: '2026-09-30T00:00:00.000Z|s1',
    });

    const res = await GET(makeRequest('/api/history'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.botProfileUrl).toBeNull();

    // Later pages ship null for every first-page-only field.
    parseHistoryCursor.mockReturnValue({
      searchedAt: '2026-09-30T00:00:00.000Z',
      searchId: 's1',
    });
    listSearcherSearches.mockResolvedValue({
      entries: [],
      total: null,
      nextCursor: null,
    });
    const later = await GET(
      makeRequest('/api/history?cursor=2026-09-30T00%3A00%3A00.000Z%7Cs1'),
    );
    const laterBody = await later.json();

    expect(later.status).toBe(200);
    expect(laterBody.botProfileUrl).toBeNull();
    expect(laterBody.attributing).toBeNull();
  });

  it('rejects a client-supplied steamId (identity comes from the session)', async () => {
    const res = await GET(
      makeRequest('/api/history?steamId=76561198000000002'),
    );

    expect(res.status).toBe(400);
    expect(listSearcherSearches).not.toHaveBeenCalled();
  });

  it('returns 401 without a session (never an empty list)', async () => {
    resolveWatchSession.mockResolvedValueOnce({ status: 'unauthenticated' });

    const res = await GET(makeRequest('/api/history'));

    expect(res.status).toBe(401);
    expect(listSearcherSearches).not.toHaveBeenCalled();
  });

  it('rejects a non-positive limit', async () => {
    const res = await GET(makeRequest('/api/history?limit=0'));

    expect(res.status).toBe(400);
    expect(listSearcherSearches).not.toHaveBeenCalled();
  });

  it('forwards a valid cursor to the next page', async () => {
    const cursor = {
      searchedAt: '2026-09-30T00:00:00.000Z',
      searchId: 's1',
    };
    parseHistoryCursor.mockReturnValue(cursor);
    listSearcherSearches.mockResolvedValue({ entries: [], total: 7 });

    const res = await GET(
      makeRequest('/api/history?cursor=2026-09-30T00%3A00%3A00.000Z%7Cs1'),
    );

    expect(res.status).toBe(200);
    expect(parseHistoryCursor).toHaveBeenCalledWith(
      '2026-09-30T00:00:00.000Z|s1',
    );
    expect(listSearcherSearches).toHaveBeenCalledWith(
      STEAM_ID,
      undefined,
      cursor,
    );
  });

  it('rejects a garbage cursor instead of paging from nowhere', async () => {
    parseHistoryCursor.mockReturnValue(null);

    const res = await GET(makeRequest('/api/history?cursor=garbage'));

    expect(res.status).toBe(400);
    expect(listSearcherSearches).not.toHaveBeenCalled();
  });

  it('returns 500 when the read fails', async () => {
    listSearcherSearches.mockRejectedValue(new Error('db down'));

    const res = await GET(makeRequest('/api/history'));

    expect(res.status).toBe(500);
  });
});

describe('DELETE /api/history', () => {
  const makeDeleteRequest = (url: string, origin?: string) => {
    const headers = new Headers();
    // Browsers always send Origin on same-origin DELETE fetches; the
    // route 403s without a matching one (pinned CSRF layer).
    headers.set('origin', origin ?? 'http://localhost:3000');
    return {
      method: 'DELETE',
      url: `http://localhost:3000${url}`,
      headers,
    } as Request;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    __testIsRateLimited.mockReturnValue(false);
    resolveWatchSession.mockResolvedValue({
      status: 'authenticated',
      steamId: STEAM_ID,
    });
    deleteSearcherHistory.mockResolvedValue(4);
  });

  it('de-attributes the viewer-owned rows and reports the count', async () => {
    const res = await DELETE(makeDeleteRequest('/api/history'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ steamId: STEAM_ID, cleared: 4 });
    // Self-scoped like GET: the DAL gets the session id, never a param.
    expect(deleteSearcherHistory).toHaveBeenCalledWith(STEAM_ID);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });

  it('rejects a client-supplied steamId (identity comes from the session)', async () => {
    const res = await DELETE(
      makeDeleteRequest('/api/history?steamId=76561198000000002'),
    );

    expect(res.status).toBe(400);
    expect(deleteSearcherHistory).not.toHaveBeenCalled();
  });

  it('returns 401 without a session (nothing is cleared)', async () => {
    resolveWatchSession.mockResolvedValueOnce({ status: 'unauthenticated' });

    const res = await DELETE(makeDeleteRequest('/api/history'));

    expect(res.status).toBe(401);
    expect(deleteSearcherHistory).not.toHaveBeenCalled();
  });

  it('rejects a cross-site DELETE even with a valid session (CSRF pin)', async () => {
    const res = await DELETE(
      makeDeleteRequest('/api/history', 'https://evil.example'),
    );

    expect(res.status).toBe(403);
    expect(deleteSearcherHistory).not.toHaveBeenCalled();
  });

  it('rejects a DELETE with no origin at all (fail closed)', async () => {
    const headers = new Headers();
    const res = await DELETE({
      method: 'DELETE',
      url: 'http://localhost:3000/api/history',
      headers,
    } as Request);

    expect(res.status).toBe(403);
    expect(deleteSearcherHistory).not.toHaveBeenCalled();
  });

  it('returns 500 when the clear fails', async () => {
    deleteSearcherHistory.mockRejectedValue(new Error('db down'));

    const res = await DELETE(makeDeleteRequest('/api/history'));

    expect(res.status).toBe(500);
  });
});
