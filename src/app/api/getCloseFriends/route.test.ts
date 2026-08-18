/**
 * @jest-environment node
 */

import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import getSteamApiKey from '@/lib/getSteamApiKey';

export {};

const mockGetUserFriends = jest.fn();
const mockGetUserSummary = jest.fn();
const mockResolve = jest.fn();

jest.mock('steamapi', () =>
  jest.fn().mockImplementation(() => ({
    getUserFriends: mockGetUserFriends,
    getUserSummary: mockGetUserSummary,
    resolve: mockResolve,
  })),
);

jest.mock('../../../lib/getSteamApiKey');

const mockedGetSteamApiKey = jest.mocked(getSteamApiKey);

mockedGetSteamApiKey.mockReturnValue('fake-steam-api-key');

const { POST } = require('./route') as typeof import('./route');

const makeRequest = (body: unknown): Request =>
  new Request('http://localhost/api/getCloseFriends', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('POST /api/getCloseFriends — request validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue('76561198000000000');
  });

  it('returns 400 if target is missing', async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
  });

  it('returns 500 and handles SteamAPI errors gracefully', async () => {
    mockResolve.mockRejectedValueOnce(new Error('API Error'));
    const res = await POST(makeRequest({ target: 'target-user' }));
    expect(res.status).toBe(500);
  });
});

describe('POST /api/getCloseFriends — mutual connection counting', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calculates close friends based on mutual connections', async () => {
    mockResolve.mockResolvedValue('target-id');

    // Target has 2 friends: A and B, who are also mutual friends of
    // each other.
    mockGetUserFriends.mockImplementation((id: string) => {
      if (id === 'target-id') {
        return Promise.resolve([
          { steamID: 'friend-A' },
          { steamID: 'friend-B' },
        ]);
      }
      if (id === 'friend-A') return Promise.resolve([{ steamID: 'friend-B' }]);
      if (id === 'friend-B') return Promise.resolve([{ steamID: 'friend-A' }]);
      return Promise.resolve([]);
    });

    mockGetUserSummary.mockResolvedValue([
      { steamID: 'friend-A', nickname: 'A' },
      { steamID: 'friend-B', nickname: 'B' },
    ]);

    const res = await POST(makeRequest({ target: 'target-user' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.closeFriends).toHaveLength(2);
    // Both should have count 1 (A sees B once in friends lists, B sees A once)
    expect(data.closeFriends[0].count).toBe(1);
    expect(data.closeFriends[1].count).toBe(1);
  });
});

describe('POST /api/getCloseFriends — dropping unresolvable friends', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue('76561198000000000');
  });

  it('drops a friend whose Steam summary did not resolve instead of returning friend: null', async () => {
    const friends = [
      {
        steamID: '76561198000000001',
        friendedTimestamp: 1,
        relationship: 'friend',
      },
      {
        steamID: '76561198000000002',
        friendedTimestamp: 1,
        relationship: 'friend',
      },
    ];

    mockGetUserFriends.mockImplementation((id: string) => {
      if (id === '76561198000000000') return Promise.resolve(friends);
      return Promise.resolve([]); // friends-of-friends lookups
    });

    // Only friend #1's summary resolves; friend #2's Steam summary comes
    // back missing (private profile / deleted account / API gap).
    mockGetUserSummary.mockResolvedValue([
      { steamID: '76561198000000001', nickname: 'Alice' },
    ]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeRequest({ target: 'somevanityurl' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.closeFriends).toHaveLength(1);
    expect(data.closeFriends[0].friend.steamID).toBe('76561198000000001');
    expect(
      data.closeFriends.some((c: { friend: unknown }) => c.friend === null),
    ).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 close friend(s)'),
    );

    warnSpy.mockRestore();
  });

  it('returns all friends when every summary resolves (no warn, no drops)', async () => {
    const friends = [
      {
        steamID: '76561198000000001',
        friendedTimestamp: 1,
        relationship: 'friend',
      },
    ];

    mockGetUserFriends.mockImplementation((id: string) => {
      if (id === '76561198000000000') return Promise.resolve(friends);
      return Promise.resolve([]);
    });
    mockGetUserSummary.mockResolvedValue([
      { steamID: '76561198000000001', nickname: 'Alice' },
    ]);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await POST(makeRequest({ target: 'somevanityurl' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.closeFriends).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('resolvable Steam summary'),
    );

    warnSpy.mockRestore();
  });

  it('uses the shared MAX_CLOSE_FRIENDS cap when slicing candidates', async () => {
    const manyFriends = Array.from({ length: 30 }, (_, i) => ({
      steamID: `7656119800000${String(i).padStart(4, '0')}`,
      friendedTimestamp: 1,
      relationship: 'friend',
    }));

    mockGetUserFriends.mockImplementation((id: string) => {
      if (id === '76561198000000000') return Promise.resolve(manyFriends);
      return Promise.resolve([]);
    });

    let capturedSteamIdsRequested: string[] = [];
    mockGetUserSummary.mockImplementation((ids: string[]) => {
      capturedSteamIdsRequested = ids;
      return Promise.resolve(ids.map((id) => ({ steamID: id, nickname: id })));
    });

    const res = await POST(makeRequest({ target: 'somevanityurl' }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(capturedSteamIdsRequested).toHaveLength(MAX_CLOSE_FRIENDS);
    expect(data.closeFriends).toHaveLength(MAX_CLOSE_FRIENDS);
  });
});
