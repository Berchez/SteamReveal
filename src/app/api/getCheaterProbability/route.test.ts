/**
 * @jest-environment node
 */

import MAX_CLOSE_FRIENDS from '@/lib/closeFriendsLimits';
import getSteamApiKey from '@/lib/getSteamApiKey';

export {};

const mockResolve = jest.fn();
const mockGetUserLevel = jest.fn();
const mockGetUserSummary = jest.fn();
const mockGetUserBans = jest.fn();

jest.mock('steamapi', () =>
  jest.fn().mockImplementation(() => ({
    resolve: mockResolve,
    getUserLevel: mockGetUserLevel,
    getUserSummary: mockGetUserSummary,
    getUserBans: mockGetUserBans,
  })),
);

jest.mock('../../../lib/getSteamApiKey');
jest.mocked(getSteamApiKey).mockReturnValue('fake-steam-api-key');

// Isolate this route's validation logic from its heavier collaborators —
// none of them should ever run for a request that fails validation, and
// asserting that is the whole point of the 400 tests below.
jest.mock('./utils/badCommentsMethod', () => jest.fn().mockResolvedValue(0));
jest.mock('./utils/inventoryMethod', () => jest.fn().mockResolvedValue(0));
jest.mock('./utils/gameLibraryStatsMethod', () =>
  jest.fn().mockResolvedValue({ playTime: 0, totalGamesCount: 0 }),
);
jest.mock('./utils/csStats', () => ({
  __esModule: true,
  default: jest.fn().mockResolvedValue(null),
  CS_STATS_FIELD_ORDER: [],
  assertCsStatsShape: jest.fn(),
}));

jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({ data: { probability: 0.5 } }),
}));
import axios from 'axios';
const mockedAxiosPost = jest.mocked(axios.post);

const { POST } = require('./route') as typeof import('./route');

const makeRequest = (body: unknown): Request =>
  new Request('http://localhost/api/getCheaterProbability', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const validFriend = () => ({
  friend: { steamID: '76561198146931523', nickname: 'Alice' },
  count: 2,
});

describe('POST /api/getCheaterProbability — Ticket 8 request validation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockResolve.mockResolvedValue('76561198000000000');
    mockGetUserLevel.mockResolvedValue(10);
    mockGetUserSummary.mockResolvedValue({ steamID: '76561198000000000' });
    mockGetUserBans.mockResolvedValue([]);
  });

  it('returns 400 if target is missing', async () => {
    const res = await POST(makeRequest({ closeFriends: [] }));
    expect(res.status).toBe(400);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('returns 400 if closeFriends is not an array', async () => {
    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: 'not-an-array' }),
    );
    expect(res.status).toBe(400);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('returns 400 if closeFriends exceeds MAX_CLOSE_FRIENDS, without calling the Steam API', async () => {
    const tooMany = Array.from({ length: MAX_CLOSE_FRIENDS + 1 }, () =>
      validFriend(),
    );

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: tooMany }),
    );

    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockGetUserBans).not.toHaveBeenCalled();
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('returns 400 for a huge fabricated array without triggering Steam API calls', async () => {
    const fabricated = Array.from({ length: 5000 }, () => validFriend());

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: fabricated }),
    );

    expect(res.status).toBe(400);
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockGetUserBans).not.toHaveBeenCalled();
  });

  it('returns 400 if any closeFriends item is malformed (bad steamID)', async () => {
    const res = await POST(
      makeRequest({
        target: 'somevanityurl',
        closeFriends: [
          validFriend(),
          { friend: { steamID: 'not-a-steamid' }, count: 1 },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('returns 400 if any closeFriends item has a non-finite count', async () => {
    const res = await POST(
      makeRequest({
        target: 'somevanityurl',
        closeFriends: [
          { friend: { steamID: '76561198146931523' }, count: Infinity },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(mockedAxiosPost).not.toHaveBeenCalled();
  });

  it('accepts a well-formed request at the cap and returns 200', async () => {
    const atCap = Array.from({ length: MAX_CLOSE_FRIENDS }, () =>
      validFriend(),
    );

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: atCap }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.5);
    expect(mockedAxiosPost).toHaveBeenCalledTimes(1);
  });
});
