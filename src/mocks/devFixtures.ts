export const isMockModeEnabled = () =>
  process.env.DEV_TEST_MODE === '1' &&
  process.env.NODE_ENV !== 'production' &&
  !process.env.VERCEL_ENV;

export const isMockInvalidTarget = (target: string) =>
  target === 'estainvalido' || target === 'invalid';

export const makeMockProfile = (target: string) => {
  if (isMockInvalidTarget(target)) {
    return undefined;
  }

  return {
    steamID: target,
    nickname: `User-${target}`,
    avatar: { large: 'https://example.com/avatar.jpg', medium: '', small: '', hash: '' },
    countryCode: 'BR',
    stateCode: 'SP',
    cityID: '1',
    url: `https://steamcommunity.com/id/${target}`,
  };
};

export const makeMockCloseFriends = (_target: string) => {
  if (isMockInvalidTarget(_target)) {
    return [];
  }

  // return an empty array (fast path) — deterministic and fast for tests
  return [];
};
