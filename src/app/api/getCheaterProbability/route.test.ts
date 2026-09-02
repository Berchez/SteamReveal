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

// This suite is about Ticket 8 request validation, not rate limiting (that
// has its own coverage in src/lib/rateLimit.test.ts and in
// feedback/route.test.ts). Without this mock, every test in this file
// shares the same rate-limit bucket (all requests here hit the same
// 'unknown' IP, since none of them set x-real-ip/x-forwarded-for), and this
// route's limit is intentionally tight (5 req / 30s — the most expensive
// route in the project). That made the 6th/7th test in the file flake with
// 429 instead of the status they were actually asserting. Mocking the rate
// limiter out keeps this suite focused on the thing it's testing.
//
// Uses a relative path (not the `@/lib/...` alias) — matching the
// convention already used for getSteamApiKey above. jest.mock's path
// resolution happens ahead of the alias mapping that regular imports get,
// and the alias isn't picked up here in this project's jest config.
jest.mock('../../../lib/rateLimit', () => ({
  createRateLimiter: () => ({ isRateLimited: () => false }),
  getRequestIp: () => 'test-ip',
}));

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
jest.mock('./utils/platformBanMethod', () =>
  jest.fn().mockResolvedValue({
    score: 0,
    cheatCount: 0,
    smurfCount: 0,
    otherCount: 0,
    details: {
      faceit: { banned: false, reason: null, classification: null },
      gamersClub: { banned: false, reason: null, classification: null },
    },
  }),
);

jest.mock('axios', () => ({
  post: jest.fn().mockResolvedValue({ data: { probability: 0.5 } }),
}));
import axios from 'axios';
const mockedAxiosPost = jest.mocked(axios.post);

import getPlatformBanScore from './utils/platformBanMethod';
const mockedPlatformBan = jest.mocked(getPlatformBanScore);

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

  it('boosts the probability by 0.15 when banned for cheating on one platform', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: 1,
      cheatCount: 1,
      smurfCount: 0,
      otherCount: 0,
      details: {
        faceit: { banned: true, reason: 'Cheating', classification: 'cheat' },
        gamersClub: { banned: false, reason: null, classification: null },
      },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.65); // 0.5 + 0.15
    expect(data.featureObject.platformBanScore).toBe(1);
    expect(data.featureObject.platformBanCheatCount).toBe(1);
    expect(data.featureObject.platformBanDetails.faceit.banned).toBe(true);
  });

  it('boosts +0.15 per anti-cheat platform and caps at 0.95', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: 2,
      cheatCount: 2,
      smurfCount: 0,
      otherCount: 0,
      details: {
        faceit: { banned: true, reason: 'Cheating', classification: 'cheat' },
        gamersClub: {
          banned: true,
          reason: 'Gamers Club Anti-Cheat',
          classification: 'cheat',
        },
      },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.8); // 0.5 + 0.3
  });

  it('caps the boosted probability at 0.95', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: 2,
      cheatCount: 2,
      smurfCount: 0,
      otherCount: 0,
      details: {
        faceit: { banned: true, reason: 'Cheating', classification: 'cheat' },
        gamersClub: {
          banned: true,
          reason: 'Gamers Club Anti-Cheat',
          classification: 'cheat',
        },
      },
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { probability: 0.9 },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.95); // 0.9 + 0.3 capped
  });

  it('lowers the probability by 0.1 when banned for smurfing', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: -1,
      cheatCount: 0,
      smurfCount: 1,
      otherCount: 0,
      details: {
        faceit: { banned: false, reason: null, classification: null },
        gamersClub: {
          banned: true,
          reason: 'smurfing',
          classification: 'smurf',
        },
      },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.4); // 0.5 - 0.1
    expect(data.featureObject.platformBanScore).toBe(-1);
    expect(data.featureObject.platformBanSmurfCount).toBe(1);
  });

  it('floors the probability at 0 when smurf penalties overflow', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: -1,
      cheatCount: 0,
      smurfCount: 1,
      otherCount: 0,
      details: {
        faceit: { banned: false, reason: null, classification: null },
        gamersClub: {
          banned: true,
          reason: 'smurfing',
          classification: 'smurf',
        },
      },
    });
    mockedAxiosPost.mockResolvedValueOnce({
      data: { probability: 0.05 },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0); // 0.05 - 0.1 floored at 0
  });

  it('keeps a neutral "other" ban unchanged', async () => {
    mockedPlatformBan.mockResolvedValue({
      score: 0,
      cheatCount: 0,
      smurfCount: 0,
      otherCount: 1,
      details: {
        faceit: { banned: false, reason: null, classification: null },
        gamersClub: {
          banned: true,
          reason: 'Some other reason',
          classification: 'other',
        },
      },
    });

    const res = await POST(
      makeRequest({ target: 'somevanityurl', closeFriends: [] }),
    );
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.cheaterProbability).toBe(0.5);
    expect(data.featureObject.platformBanOtherCount).toBe(1);
  });
});
