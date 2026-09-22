import { getBanCheckApiKey, parseBanVerdict } from './banCheck';

// steamapi ships ESM-only (dist/index.js uses import statements), which the
// jsdom Jest transform cannot parse — stub it: these tests never touch the
// network (fail-open null contract), they only assert key precedence.
jest.mock('steamapi', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    getUserBans: jest.fn(async () => {
      throw new Error('stubbed: no network in unit tests');
    }),
  })),
}));

describe('getBanCheckApiKey', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('prefers the dedicated sweep key when set (quota isolation)', () => {
    process.env.STEAM_BAN_CHECK_API_KEY = 'dedicated-key';
    process.env.STEAM_API_KEY = 'shared-1';
    expect(getBanCheckApiKey()).toBe('dedicated-key');
  });

  it('falls back to the shared pool when unset', () => {
    delete process.env.STEAM_BAN_CHECK_API_KEY;
    process.env.STEAM_API_KEY = 'shared-1';
    delete process.env.STEAM_API_KEY_2;
    expect(getBanCheckApiKey()).toBe('shared-1');
  });

  it('returns undefined when no key exists anywhere', () => {
    delete process.env.STEAM_BAN_CHECK_API_KEY;
    delete process.env.STEAM_API_KEY;
    delete process.env.STEAM_API_KEY_2;
    expect(getBanCheckApiKey()).toBeUndefined();
  });
});

describe('isSteamTargetBanned (contract)', () => {
  it('never throws without credentials (fail-open null)', async () => {
    jest.resetModules();
    delete process.env.STEAM_BAN_CHECK_API_KEY;
    delete process.env.STEAM_API_KEY;
    delete process.env.STEAM_API_KEY_2;
    const { isSteamTargetBanned } = require('./banCheck');
    // No key + no network in unit tests: steamapi surfaces an error, which
    // must degrade to null (unknown), never to a throw.
    await expect(isSteamTargetBanned('76561198000000001', 1000)).resolves.toBeNull();
  });
});

describe('parseBanVerdict (shared single/batch parser)', () => {
  // Fixtures mirror the installed steamapi UserBans structure
  // (dist/src/structures/UserBans.js: vacBans/gameBans numbers mapped from
  // NumberOfVACBans/NumberOfGameBans, steamID from the User base) — the
  // same names the production bannedFriendsMethod lane already relies on.
  // Contract is lib instances, NOT raw Steam JSON (PascalCase): callers
  // only ever receive what steam.getUserBans returns.
  const libRow = (overrides = {}) => ({
    steamID: '76561198000000001',
    communityBanned: false,
    vacBanned: false,
    vacBans: 0,
    gameBans: 0,
    economyBan: 'none',
    daysSinceLastBan: 0,
    ...overrides,
  });

  it('detects VAC bans and game bans', () => {
    expect(parseBanVerdict(libRow({ vacBans: 2, vacBanned: true }))).toBe(true);
    expect(parseBanVerdict(libRow({ gameBans: 1 }))).toBe(true);
    expect(
      parseBanVerdict(libRow({ vacBans: 1, gameBans: 3 })),
    ).toBe(true);
  });

  it('reads clean rows as clean', () => {
    expect(parseBanVerdict(libRow())).toBe(false);
  });

  it('ignores community/economy bans (cheater scope is VAC + game only)', () => {
    expect(
      parseBanVerdict(libRow({ communityBanned: true })),
    ).toBe(false);
    expect(
      parseBanVerdict(libRow({ economyBan: 'banned' })),
    ).toBe(false);
  });

  it('returns null (unknown, never a guess) for malformed rows', () => {
    expect(parseBanVerdict(null)).toBeNull();
    expect(parseBanVerdict(undefined)).toBeNull();
    expect(parseBanVerdict('banned')).toBeNull();
    // Absent keys are unknown, NOT clean: a shape drift must degrade to
    // "skip", never to a false clean persisted in the baseline.
    expect(parseBanVerdict({})).toBeNull();
    expect(parseBanVerdict(libRow({ vacBans: undefined }))).toBeNull();
    expect(parseBanVerdict(libRow({ gameBans: null }))).toBeNull();
    expect(parseBanVerdict(libRow({ vacBans: 'abc' }))).toBeNull();
    expect(parseBanVerdict(libRow({ gameBans: NaN }))).toBeNull();
    // Raw Steam JSON (PascalCase) is NOT the contract — without the mapped
    // names the row is unknown, even when it carries bans.
    expect(
      parseBanVerdict({ NumberOfVACBans: 5, NumberOfGameBans: 0 }),
    ).toBeNull();
  });
});
