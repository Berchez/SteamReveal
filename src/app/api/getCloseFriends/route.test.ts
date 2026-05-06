import { POST } from './route';

// Mock SteamAPI
const mockResolve = jest.fn();
const mockGetUserFriends = jest.fn();
const mockGetUserSummary = jest.fn();

jest.mock('steamapi', () => {
  return jest.fn().mockImplementation(() => ({
    resolve: (target: string) => mockResolve(target),
    getUserFriends: (steamID: string) => mockGetUserFriends(steamID),
    getUserSummary: (steamIDs: string[]) => mockGetUserSummary(steamIDs),
  }));
});

jest.mock('next/server', () => ({
  NextResponse: {
    json: jest.fn((body, init) => ({
      status: init?.status ?? 200,
      json: async () => body,
    })),
  },
}));

describe('POST /api/getCloseFriends', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 400 if target is missing', async () => {
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({}),
    } as any;

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it('calculates close friends based on mutual connections', async () => {
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({ target: 'target-user' }),
    } as any;

    mockResolve.mockResolvedValue('target-id');

    // Target has 2 friends: A and B
    mockGetUserFriends.mockImplementation((id: string) => {
      if (id === 'target-id') {
        return Promise.resolve([
          { steamID: 'friend-A' },
          { steamID: 'friend-B' },
        ]);
      }
      if (id === 'friend-A') {
        // Friend A is friends with B
        return Promise.resolve([{ steamID: 'friend-B' }]);
      }
      if (id === 'friend-B') {
        // Friend B is friends with A
        return Promise.resolve([{ steamID: 'friend-A' }]);
      }
      return Promise.resolve([]);
    });

    mockGetUserSummary.mockResolvedValue([
      { steamID: 'friend-A', nickname: 'A' },
      { steamID: 'friend-B', nickname: 'B' },
    ]);

    const res = await POST(req);
    expect(res.status).toBe(200);

    const data = await res.json();
    expect(data.closeFriends).toHaveLength(2);
    // Both should have count 1 (A sees B once in friends lists, B sees A once)
    expect(data.closeFriends[0].count).toBe(1);
    expect(data.closeFriends[1].count).toBe(1);
  });

  it('handles SteamAPI errors gracefully', async () => {
    const req = {
      method: 'POST',
      json: jest.fn().mockResolvedValue({ target: 'target-user' }),
    } as any;

    mockResolve.mockRejectedValue(new Error('API Error'));

    const res = await POST(req);
    expect(res.status).toBe(500);
  });
});
