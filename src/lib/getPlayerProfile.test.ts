/**
 * @jest-environment node
 *
 * getPlayerProfile is a server-only RSC util (uses `react.cache`). In a plain
 * Node/jest context `react` (18.3) does not export `cache`, so we stub it to
 * an identity fn — the memoization itself is React's job in SSR and is not
 * what we're exercising here; we care about the enrichment + mapping.
 */
jest.mock('react', () => ({
  ...jest.requireActual('react'),
  cache: (fn: unknown) => fn,
}));

jest.mock('steamapi', () => {
  class MockGame {
    id: number;
    name?: string;
    constructor(data: { appid: number; name?: string }) {
      this.id = data.appid;
      this.name = data.name;
    }
  }
  class MockUserPlaytime {
    game: MockGame;
    minutes: number;
    constructor(data: {
      appid: number;
      name?: string;
      playtime_forever?: number;
    }) {
      this.game = new MockGame({ appid: data.appid, name: data.name });
      this.minutes = data.playtime_forever ?? 0;
    }
  }
  class MockSteamAPI {
    constructor(_key: string) {}
    async resolve(target: string) {
      return target;
    }
    async getUserSummary(_steamId: string) {
      return {
        steamID: '111',
        nickname: 'Player',
        url: 'https://steamcommunity.com/id/player',
        avatar: { small: '', medium: '', large: '', hash: '' },
      };
    }
  }
  return { __esModule: true, default: MockSteamAPI };
});

// withTimeout duplicated the call; make it identity so the mocked SteamAPI
// drives the outcome without an 8s race timer lingering in tests.
jest.mock('@/lib/withTimeout', () => ({
  __esModule: true,
  default: (fn: Promise<unknown>) => fn,
  SteamCallTimeoutError: class extends Error {},
}));

jest.mock('@/lib/getSteamApiKey', () => ({
  __esModule: true,
  default: jest.fn(() => 'fake-key'),
}));

// Control getUserOwnedGames per-test by reaching into the mocked SteamAPI class.
// It's exported only for the test to rebind — simplest is to keep a module ref and
// mutate getUserOwnedGames through it.
import SteamAPI from 'steamapi';
import getPlayerProfile from './getPlayerProfile';

describe('getPlayerProfile — SSR isCSActive enrichment', () => {
  // Each test rebinds the mocked SteamAPI's getUserOwnedGames.
  const setOwnedGames = (impl: () => Promise<unknown>) => {
    (SteamAPI as unknown as { prototype: { getUserOwnedGames: unknown } }).prototype.getUserOwnedGames =
      jest.fn(impl);
  };

  it('enriches isCSActive=true when the owned games show active Counter-Strike', async () => {
    // One CS game with 18000 min = 300h → the >=300h branch fires.
    setOwnedGames(async () => [
      { game: { name: 'Counter-Strike 2' }, minutes: 18000 },
    ]);

    const result = await getPlayerProfile('player-a');

    expect(result?.steamID).toBe('111');
    expect(result?.isCSActive).toBe(true);
  });

  it('enriches isCSActive=false when Counter-Strike is not active', async () => {
    setOwnedGames(async () => [
      { game: { name: 'Dota 2' }, minutes: 60 },
    ]);

    const result = await getPlayerProfile('player-a');

    expect(result?.isCSActive).toBe(false);
  });

  it('leaves isCSActive undefined (and keeps the profile) when owned-games lookup fails', async () => {
    setOwnedGames(async () => {
      throw new Error('steam down');
    });

    const result = await getPlayerProfile('player-a');

    expect(result?.steamID).toBe('111');
    expect(result?.isCSActive).toBeUndefined();
  });
});