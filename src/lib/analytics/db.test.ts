// The factory is hoisted, but jest allows referencing variables that start
// with `mock` — keeping the SAME jest.fn() across jest.resetModules() so the
// test's setup (mockReturnValue) is still bound after a fresh require of ./db.
const mockCreateClient = jest.fn();

jest.mock('@libsql/client', () => ({
  createClient: mockCreateClient,
}));

const mockExecute = jest.fn().mockResolvedValue({ rows: [] });
const mockBatch = jest.fn().mockResolvedValue({});
const mockClose = jest.fn();

function buildMockClient(): void {
  mockCreateClient.mockReturnValue({
    execute: mockExecute,
    batch: mockBatch,
    close: mockClose,
  } as never);
}

describe('analytics db DAL', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    mockCreateClient.mockClear();
    mockExecute.mockClear();
    mockBatch.mockClear();
    mockClose.mockClear();
    buildMockClient();
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const newSearchInput = {
    profile: { steamId: '76561198000000000', cityId: 2786 },
    friends: [],
    isCSActive: true,
    durationMs: 500,
  };

  it('creates a single client when calls race during cold start', async () => {
    const { recordSearch } = require('./db');

    await Promise.all([
      recordSearch(newSearchInput),
      recordSearch({ ...newSearchInput, profile: { steamId: '9'.repeat(17) } }),
    ]);

    expect(mockCreateClient).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledWith('PRAGMA foreign_keys = ON');
    expect(mockBatch).toHaveBeenCalledTimes(2);
  });

  it('retries after a failed first connection attempt', async () => {
    delete process.env.DATABASE_URL;
    const { recordSearch } = require('./db');

    await expect(recordSearch(newSearchInput)).rejects.toThrow(
      'DATABASE_URL is missing',
    );

    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    const record = await recordSearch(newSearchInput);

    expect(record.id).toBeTruthy();
    // The failed call never reached createClient; the retry creates it once.
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it('coerces a numeric cityId to TEXT and encodes booleans', async () => {
    const { recordSearch } = require('./db');
    await recordSearch(newSearchInput);

    const profileStatement = mockBatch.mock.calls[0][0].find(
      (statement: { sql: string }) =>
        statement.sql.includes('INSERT INTO profiles'),
    );

    expect(profileStatement).toBeDefined();
    expect(profileStatement.args).toEqual(
      expect.arrayContaining(['76561198000000000', null, null, '2786', 1, 500]),
    );
  });

  it('keeps null cityId null when absent', async () => {
    const { recordSearch } = require('./db');
    await recordSearch({
      profile: { steamId: '76561198000000000' },
      friends: [],
    });

    const profileStatement = mockBatch.mock.calls[0][0].find(
      (statement: { sql: string }) =>
        statement.sql.includes('INSERT INTO profiles'),
    );

    expect(profileStatement.args).toContain(null);
    expect(profileStatement.args).not.toContain('null');
  });
});

describe('getSearchRecords read path', () => {
  const searchId = '1699999999999-abc123';
  const searchedAt = '2023-11-14T12:00:00.000Z';

  const searchRow = {
    id: searchId,
    searched_at: searchedAt,
    steam_id: '76561198000000000',
    steam_url: null,
    nickname: 'Nick',
    gc_name: 'GCName',
    country_code: 'BR',
    state_code: 'SP',
    city_id: '2786',
    is_cs_active: 1,
    duration_ms: 500,
    requester_locale: 'pt',
    requester_country: 'BR',
    requester_browser_language: 'pt-BR',
    device: 'desktop',
  };

  beforeEach(() => {
    // This describe lives OUTSIDE the "analytics db DAL" block above, so it
    // re-does that block's setup itself: a fresh db module (resetModules →
    // new memoized clientPromise → its PRAGMA call) and a clean Once-queue.
    jest.resetModules();
    mockCreateClient.mockClear();
    mockExecute.mockClear();
    mockBatch.mockClear();
    mockClose.mockClear();
    buildMockClient();
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';

    // getClient() punches PRAGMA foreign_keys first; the five read queries
    // (Promise.all) follow in a deterministic order for the Once-chain.
    mockExecute.mockResolvedValueOnce({ rows: [] });
  });

  it('returns an empty list when the database has no searches', async () => {
    const { getSearchRecords } = require('./db');

    await expect(getSearchRecords()).resolves.toEqual([]);
  });

  it('reconstructs a bare record from the 1:1 join', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [searchRow] });
    const { getSearchRecords } = require('./db');

    const [record] = await getSearchRecords();

    expect(record).toEqual({
      id: searchId,
      searchedAt,
      profile: {
        steamId: '76561198000000000',
        steamUrl: null,
        nickname: 'Nick',
        gcName: 'GCName',
        countryCode: 'BR',
        stateCode: 'SP',
        cityId: '2786',
      },
      friends: [],
      gamesSnapshot: null,
      isCSActive: true,
      requesterLocale: 'pt',
      requesterCountry: 'BR',
      requesterBrowserLanguage: 'pt-BR',
      device: 'desktop',
      locationGuess: null,
      cheater: null,
      durationMs: 500,
    });
  });

  it('attaches friends, games, location guesses and the cheater result', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [searchRow] });
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          search_id: searchId,
          id: 1,
          steam_id: '76561198000001111',
          nickname: 'F1',
          gc_name: null,
          mutual_count: 3,
          probability: 87.5,
          country_code: 'US',
        },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [{ search_id: searchId, id: 1, name: 'Counter-Strike 2', playtime_hours: 120.5 }],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          search_id: searchId,
          id: 1,
          location: '{"cityName":"Sao Paulo","countryCode":"BR"}',
          probability: 0.93,
        },
      ],
    });
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          search_id: searchId,
          score: 72,
          banned_friends_count: 4,
          computed_at: '2023-11-14T13:00:00.000Z',
        },
      ],
    });

    const { getSearchRecords } = require('./db');
    const [record] = await getSearchRecords();

    expect(record.friends).toEqual([
      {
        steamId: '76561198000001111',
        nickname: 'F1',
        gcName: null,
        mutualCount: 3,
        probability: 87.5,
        countryCode: 'US',
      },
    ]);
    expect(record.gamesSnapshot).toEqual([
      { name: 'Counter-Strike 2', playtimeHours: 120.5 },
    ]);
    expect(record.locationGuess).toEqual([
      { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 0.93 },
    ]);
    expect(record.cheater).toEqual({
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2023-11-14T13:00:00.000Z',
    });
  });

  it('maps is_cs_active NULL / invalid device to null instead of crashing', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [{ ...searchRow, is_cs_active: null, device: 'potato', city_id: null }],
    });

    const { getSearchRecords } = require('./db');
    const [record] = await getSearchRecords();

    expect(record.isCSActive).toBeNull();
    expect(record.device).toBeNull();
    expect(record.profile.cityId).toBeNull();
    expect(record.cheater).toBeNull();
  });
});