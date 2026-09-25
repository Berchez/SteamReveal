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
    // The snapshot must travel with the seeded profile — recordAnalytics
    // recomputes the flag from it, and without it every direct
    // /player/[steamId] load recorded isCSActive=false (frozen dashboard).
    expect(result?.gamesSnapshot).toEqual([
      { name: 'Counter-Strike 2', playtimeHours: 300 },
    ]);
  });

  it('enriches isCSActive=false when Counter-Strike is not active', async () => {
    setOwnedGames(async () => [
      { game: { name: 'Dota 2' }, minutes: 60 },
    ]);

    const result = await getPlayerProfile('player-a');

    expect(result?.isCSActive).toBe(false);
    expect(result?.gamesSnapshot).toEqual([
      { name: 'Dota 2', playtimeHours: 1 },
    ]);
  });

  it('leaves isCSActive undefined (and keeps the profile) when owned-games lookup fails', async () => {
    setOwnedGames(async () => {
      throw new Error('steam down');
    });

    const result = await getPlayerProfile('player-a');

    expect(result?.steamID).toBe('111');
    expect(result?.isCSActive).toBeUndefined();
    expect(result?.gamesSnapshot).toBeUndefined();
  });

  it('returns undefined for a 17-digit target outside the SteamID64 span, before any Steam call', async () => {
    // The production garbage (2026-09 ops log): resolve() passes 17-digit
    // inputs straight through, so without the guard every Steam call
    // would fail with Bad Request/No players found as error-level logs.
    const resolveFn = jest.fn(async (target: string) => target);
    const proto = (SteamAPI as unknown as { prototype: { resolve: unknown } })
      .prototype;
    const originalResolve = proto.resolve;
    proto.resolve = resolveFn;

    try {
      const result = await getPlayerProfile('44846128515546448');

      expect(result).toBeUndefined();
      expect(resolveFn).not.toHaveBeenCalled();
    } finally {
      proto.resolve = originalResolve;
    }
  });

  it('warns (never error-logs) when the owned-games failure is data-unavailability', async () => {
    // Private/empty library = steamapi's own TypeError on `games.map`;
    // bogus/gone profile = Bad Request. Both are routine, user-triggerable
    // conditions — they must not read like outages in the ops log.
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});

    setOwnedGames(async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'map')");
    });
    const privateLib = await getPlayerProfile('player-a');
    expect(privateLib?.steamID).toBe('111');
    expect(privateLib?.isCSActive).toBeUndefined();

    setOwnedGames(async () => {
      throw new Error('Bad Request');
    });
    const goneProfile = await getPlayerProfile('player-a');
    expect(goneProfile?.steamID).toBe('111');
    expect(goneProfile?.isCSActive).toBeUndefined();

    expect(consoleWarnSpy).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  it('keeps a genuine enrichment failure at error level (incident stays loud)', async () => {
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    setOwnedGames(async () => {
      throw new Error('socket hang up');
    });

    const result = await getPlayerProfile('player-a');
    expect(result?.steamID).toBe('111');
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);

    consoleErrorSpy.mockRestore();
  });
});
