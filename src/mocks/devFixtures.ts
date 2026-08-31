export const isMockModeEnabled = () =>
  process.env.DEV_TEST_MODE === '1' &&
  process.env.NODE_ENV !== 'production' &&
  !process.env.VERCEL_ENV;

export const isMockInvalidTarget = (target: string) =>
  target === 'estainvalido' || target === 'invalid';

// countryCode/stateCode/cityID correspond to a REAL entry in
// lib/locations/data/BR.json (Amambai, Mato Grosso do Sul) — chosen
// deliberately so getLocationDetails resolves to real, assertable names
// instead of silently returning undefined fields.
export const makeMockProfile = (target: string) => {
  if (isMockInvalidTarget(target)) {
    return undefined;
  }

  return {
    steamID: target,
    nickname: `User-${target}`,
    avatar: {
      large: 'https://example.com/avatar.jpg',
      medium: '',
      small: '',
      hash: '',
    },
    countryCode: 'BR',
    stateCode: '11',
    cityID: '7179',
    url: `https://steamcommunity.com/id/${target}`,
  };
};

const targetsWithFriends = new Set(['player-with-friends']);

/**
 * Shape matches the contract computeCloseFriendsProbability expects:
 * { friend, count } — NOT a flat UserSummary. The real /api/getCloseFriends
 * route pairs each friend with a mutual-friends count and returns them
 * already sorted descending by count (a documented precondition in
 * probabilityMath.ts). Both friends share the same city on purpose, so
 * computeCityScores multiplies their counts together (10 * 5 = 50),
 * producing deterministic, hand-verifiable numbers on screen.
 */
export const makeMockCloseFriends = (target: string) => {
  if (isMockInvalidTarget(target)) {
    return [];
  }

  if (!targetsWithFriends.has(target)) {
    return [];
  }

  return [
    {
      friend: {
        steamID: 'friend-1',
        nickname: 'FriendOne',
        avatar: {
          large: 'https://example.com/f1.jpg',
          medium: 'https://example.com/f1-m.jpg',
          small: '',
          hash: '',
        },
        countryCode: 'BR',
        stateCode: '11',
        cityID: '7179',
        url: 'https://steamcommunity.com/id/friend-1',
      },
      count: 10,
    },
    {
      friend: {
        steamID: 'friend-2',
        nickname: 'FriendTwo',
        avatar: {
          large: 'https://example.com/f2.jpg',
          medium: 'https://example.com/f2-m.jpg',
          small: '',
          hash: '',
        },
        countryCode: 'BR',
        stateCode: '11',
        cityID: '7179',
        url: 'https://steamcommunity.com/id/friend-2',
      },
      count: 5,
    },
  ];
};

export const makeMockCheaterProbability = () => ({
  cheaterProbability: 0.5,
  featureObject: { bannedFriendsDetails: [] },
});
