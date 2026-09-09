/**
 * @jest-environment node
 *
 * The mocked @libsql/client is fully offline (createClient/buildMockClient),
 * but the node env matches the production runtime and keeps this file
 * consistent with db.integration.test.ts, which needs it for file::memory:.
 */

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

  it('drops the memoized client after a connection-level failure so the next call reconnects', async () => {
    const { recordSearch } = require('./db');
    await recordSearch(newSearchInput);

    mockBatch.mockRejectedValueOnce(new Error('The session is closed'));
    await expect(recordSearch(newSearchInput)).rejects.toThrow('session is closed');

    // The dead client must not be reused: the next call rebuilds it.
    await recordSearch(newSearchInput);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it('keeps reusing the memoized client on ordinary DB errors (no reconnect)', async () => {
    const { recordSearch } = require('./db');
    await recordSearch(newSearchInput);

    mockBatch.mockRejectedValueOnce(new Error('db down'));
    await expect(recordSearch(newSearchInput)).rejects.toThrow('db down');

    mockBatch.mockResolvedValue({});
    await recordSearch(newSearchInput);
    // A generic failure is not a transport error — the client stays cached.
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

  it('surfaces a db:migrate hint instead of a raw "no such table"', async () => {
    mockBatch.mockRejectedValueOnce(new Error('no such table: searches'));
    const { recordSearch } = require('./db');

    await expect(recordSearch(newSearchInput)).rejects.toThrow(
      'Analytics database schema is missing — run `pnpm run db:migrate` first.',
    );
  });

  it('hints db:migrate when attachCheaterProbability hits a missing schema', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }); // PRAGMA foreign_keys
    mockExecute.mockRejectedValueOnce(new Error('no such table: searches'));
    const { attachCheaterProbability } = require('./db');

    await expect(
      attachCheaterProbability('some-search-id', {
        score: 1,
        bannedFriendsCount: null,
        computedAt: '2026-09-05T00:00:00.000Z',
      }),
    ).rejects.toThrow(/db:migrate/);
  });
});

describe('attachFriendGcNames backfill', () => {
  beforeEach(() => {
    jest.resetModules();
    // reset (not clear) to drop any mockResolvedValueOnce queue leaked by
    // other describes; defaults are restored below.
    mockCreateClient.mockReset();
    mockExecute.mockReset();
    mockBatch.mockReset();
    mockClose.mockReset();
    buildMockClient();
    // Every execute resolves empty by default (PRAGMA + the exists SELECT).
    mockExecute.mockResolvedValue({ rows: [] });
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';
  });

  it('reports a missing search as searchExists:false without touching batch', async () => {
    const { attachFriendGcNames } = require('./db');

    const result = await attachFriendGcNames('no-such-search', [
      { steamId: '76561198000000001', gcName: 'Alice' },
    ]);

    expect(result).toEqual({ searchExists: false, updated: 0 });
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('updates one row per valid entry and sums rowsAffected', async () => {
    // PRAGMA resolve → exists-SELECT finds the search → batch UPDATEs.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [{}] });
    mockBatch.mockResolvedValue([{ rowsAffected: 1 }, { rowsAffected: 2 }]);

    const { attachFriendGcNames } = require('./db');

    const result = await attachFriendGcNames('search-id', [
      { steamId: '76561198000000001', gcName: 'Alice' },
      { steamId: '76561198000000002', gcName: 'Bob' },
    ]);

    expect(result).toEqual({ searchExists: true, updated: 3 });
    const statements = mockBatch.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0]).toEqual({
      sql: 'UPDATE friends SET gc_name = ? WHERE search_id = ? AND steam_id = ?',
      args: ['Alice', 'search-id', '76561198000000001'],
    });
    expect(statements[1].args).toEqual(['Bob', 'search-id', '76561198000000002']);
  });

  it('filters blank/oversized names and invalid steamIds before writing', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [{}] });
    mockBatch.mockResolvedValue([{ rowsAffected: 1 }]);

    const { attachFriendGcNames } = require('./db');

    const result = await attachFriendGcNames('search-id', [
      { steamId: '76561198000000001', gcName: 'Ok' },
      { steamId: '76561198000000002', gcName: '   ' },
      { steamId: 'short', gcName: 'No' },
      { steamId: '76561198000000003', gcName: 'x'.repeat(2001) },
      { steamId: '76561198000000004', gcName: null as unknown as string },
      null as unknown as { steamId: string; gcName: string },
    ]);

    expect(result).toEqual({ searchExists: true, updated: 1 });
    const statements = mockBatch.mock.calls[0][0];
    expect(statements).toHaveLength(1);
    expect(statements[0].args).toEqual(['Ok', 'search-id', '76561198000000001']);
  });

  it('treats an empty batch as a successful no-op', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [{}] });

    const { attachFriendGcNames } = require('./db');

    const result = await attachFriendGcNames('search-id', [
      { steamId: '76561198000000001', gcName: '   ' },
    ]);

    expect(result).toEqual({ searchExists: true, updated: 0 });
    expect(mockBatch).not.toHaveBeenCalled();
  });

  it('hints db:migrate when the backfill hits a missing schema', async () => {
    // First call is the PRAGMA during client init; reject the SELECT after.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockRejectedValueOnce(new Error('no such table: searches'));

    const { attachFriendGcNames } = require('./db');

    await expect(
      attachFriendGcNames('search-id', [
        { steamId: '76561198000000001', gcName: 'Alice' },
      ]),
    ).rejects.toThrow(/db:migrate/);
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

    // getClient() punches PRAGMA foreign_keys first; getSearchRecords then
    // runs the five reads in ONE db.batch() (consistent snapshot) whose
    // result sets default to empty rows unless a test overrides a slot.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockBatch.mockResolvedValue([
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
  });

  it('returns an empty list when the database has no searches', async () => {
    const { getSearchRecords } = require('./db');

    await expect(getSearchRecords()).resolves.toEqual([]);
  });

  it('reconstructs a bare record from the 1:1 join', async () => {
    mockBatch.mockResolvedValueOnce([
      { rows: [searchRow] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);
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
    mockBatch.mockResolvedValueOnce([
      { rows: [searchRow] },
      {
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
      },
      {
        rows: [{ search_id: searchId, id: 1, name: 'Counter-Strike 2', playtime_hours: 120.5 }],
      },
      {
        rows: [
          {
            search_id: searchId,
            id: 1,
            location: '{"cityName":"Sao Paulo","countryCode":"BR"}',
            probability: 87.5,
          },
        ],
      },
      {
        rows: [
          {
            search_id: searchId,
            score: 72,
            banned_friends_count: 4,
            computed_at: '2023-11-14T13:00:00.000Z',
          },
        ],
      },
    ]);

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
      { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 87.5 },
    ]);
    expect(record.cheater).toEqual({
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2023-11-14T13:00:00.000Z',
    });
  });

  it('maps is_cs_active NULL / invalid device to null instead of crashing', async () => {
    mockBatch.mockResolvedValueOnce([
      {
        rows: [{ ...searchRow, is_cs_active: null, device: 'potato', city_id: null }],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);

    const { getSearchRecords } = require('./db');
    const [record] = await getSearchRecords();

    expect(record.isCSActive).toBeNull();
    expect(record.device).toBeNull();
    expect(record.profile.cityId).toBeNull();
    expect(record.cheater).toBeNull();
  });

  it('skips a corrupted location JSON row instead of breaking the dashboard', async () => {
    mockBatch.mockResolvedValueOnce([
      { rows: [searchRow] },
      { rows: [] },
      { rows: [] },
      {
        rows: [
          {
            search_id: searchId,
            id: 1,
            location: '{not-valid-json',
            probability: 87.5,
          },
        ],
      },
      { rows: [] },
    ]);

    const { getSearchRecords } = require('./db');
    const [record] = await getSearchRecords();

    expect(record.id).toBe(searchId);
    expect(record.locationGuess).toEqual([]);
    expect(record.friends).toEqual([]);
  });

  it('hints db:migrate when the read path hits a missing schema', async () => {
    mockBatch.mockRejectedValueOnce(new Error('no such table: searches'));
    const { getSearchRecords } = require('./db');

    await expect(getSearchRecords()).rejects.toThrow(/db:migrate/);
  });

  it('drops a search whose profile row is missing (LEFT JOIN null steam_id)', async () => {
    mockBatch.mockResolvedValueOnce([
      {
        rows: [
          { id: 'orphan-1', searched_at: '2026-09-04T20:00:00.000Z', steam_id: null },
          { id: 'orphan-2', searched_at: '2026-09-04T21:00:00.000Z', steam_id: '' },
          searchRow,
        ],
      },
      { rows: [] },
      { rows: [] },
      { rows: [] },
      { rows: [] },
    ]);

    const { getSearchRecords } = require('./db');
    const records = await getSearchRecords();

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(searchId);
    expect(records[0].profile.steamId).toBe('76561198000000000');
  });
});

describe('watch/outbox DAL (Epic 1)', () => {
  const STEAM = '76561198000000000';

  beforeEach(() => {
    jest.resetModules();
    mockCreateClient.mockReset();
    mockExecute.mockReset();
    mockBatch.mockReset();
    mockClose.mockReset();
    buildMockClient();
    // Every execute resolves empty by default (pre-check SELECTs).
    mockExecute.mockResolvedValue({ rows: [] });
    // Every test below requires a fresh ./db (module reset above), so its
    // first execute is always getClient's PRAGMA — reserve it up front so
    // per-test mockResolvedValueOnce queues line up with real statements.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';
  });

  const watchRow = (overrides = {}) => ({
    steam_id: STEAM,
    status: 'pending',
    locale: null,
    requested_at: '2026-09-08T00:00:00.000Z',
    activated_at: null,
    last_notified_at: null,
    ...overrides,
  });

  it('createWatchRequest inserts pending and returns the mapped row', async () => {
    // PRAGMA placeholder comes from beforeEach; INSERT takes the default
    // empty rows, SELECT takes the row below.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [watchRow()] });

    const { createWatchRequest } = require('./db');
    const profile = await createWatchRequest(STEAM, 'pt');

    expect(profile).toEqual({
      steamId: STEAM,
      status: 'pending',
      locale: null,
      requestedAt: '2026-09-08T00:00:00.000Z',
      activatedAt: null,
      lastNotifiedAt: null,
    });
    const insert = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watched_profiles'),
    );
    expect(insert).toBeDefined();
    expect(String(insert[0]?.sql ?? insert[0])).toContain(
      'ON CONFLICT(steam_id) DO NOTHING',
    );
    expect(insert[0].args[0]).toBe(STEAM);
    expect(insert[0].args[1]).toBe('pt');
    expect(typeof insert[0].args[2]).toBe('string');
  });

  it('createWatchRequest returns the existing row untouched on duplicate (no second insert possible)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({
      rows: [watchRow({ status: 'active', activated_at: '2026-09-08T01:00:00.000Z' })],
    });

    const { createWatchRequest } = require('./db');
    const profile = await createWatchRequest(STEAM);

    expect(profile.status).toBe('active');
    expect(profile.locale).toBeNull();
    const inserts = mockExecute.mock.calls.filter((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watched_profiles'),
    );
    // Exactly one INSERT attempt (made a no-op by the constraint) + SELECT.
    expect(inserts).toHaveLength(1);
  });

  it('createWatchRequest coerces a malformed locale to null instead of failing', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [watchRow()] });

    const { createWatchRequest } = require('./db');
    await createWatchRequest(STEAM, 'pt-BR!!');

    const insert = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watched_profiles'),
    );
    expect(insert[0].args[1]).toBeNull();
  });

  it('createWatchRequest throws on invalid steamId before touching the client', async () => {
    const { createWatchRequest } = require('./db');

    await expect(createWatchRequest('short')).rejects.toThrow(/17 digits/);
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('activateWatch flips pending->active with activated_at', async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

    const { activateWatch } = require('./db');
    await expect(activateWatch(STEAM)).resolves.toBe(true);

    const update = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watched_profiles'),
    );
    expect(String(update[0]?.sql ?? update[0])).toContain("status = 'active'");
    expect(String(update[0]?.sql ?? update[0])).toContain("status = 'pending'");
  });

  it('activateWatch is idempotent on already-active watches', async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    mockExecute.mockResolvedValueOnce({ rows: [{ status: 'active' }] });

    const { activateWatch } = require('./db');
    await expect(activateWatch(STEAM)).resolves.toBe(true);
  });

  it('activateWatch returns false when nothing was ever requested', async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    mockExecute.mockResolvedValueOnce({ rows: [] });

    const { activateWatch } = require('./db');
    await expect(activateWatch(STEAM)).resolves.toBe(false);
  });

  it('deactivateWatch deletes the row (opt-out PII removal)', async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });

    const { deactivateWatch } = require('./db');
    await expect(deactivateWatch(STEAM)).resolves.toBe(true);

    const del = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('DELETE FROM watched_profiles'),
    );
    expect(del).toBeDefined();
  });

  it('deactivateWatch returns false when nothing was stored', async () => {
    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });

    const { deactivateWatch } = require('./db');
    await expect(deactivateWatch(STEAM)).resolves.toBe(false);
  });

  it('getWatchStatus maps pending/active/null and collapses garbage to pending', async () => {
    const { getWatchStatus } = require('./db');

    mockExecute.mockResolvedValueOnce({ rows: [{ status: 'pending' }] });
    await expect(getWatchStatus(STEAM)).resolves.toBe('pending');

    mockExecute.mockResolvedValueOnce({ rows: [{ status: 'active' }] });
    await expect(getWatchStatus(STEAM)).resolves.toBe('active');

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(getWatchStatus(STEAM)).resolves.toBeNull();

    // Same contract as toWatchedProfile: the row exists but is not active.
    mockExecute.mockResolvedValueOnce({ rows: [{ status: 'banned' }] });
    await expect(getWatchStatus(STEAM)).resolves.toBe('pending');
  });

  it('getWatchStatus throws on invalid steamId', async () => {
    const { getWatchStatus } = require('./db');

    await expect(getWatchStatus('nope')).rejects.toThrow(/17 digits/);
  });

  it('enqueueEvent inserts a notify with the search id (not a duplicate)', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] }); // pre-check: unseen
    mockExecute.mockResolvedValueOnce({ rows: [], lastInsertRowid: 7 });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'notify', 'search-1');

    expect(result).toEqual({ eventId: 7, duplicate: false });
    const insert = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watch_events'),
    );
    expect(insert[0].args).toEqual([
      'search-1',
      STEAM,
      'notify',
      expect.any(String),
    ]);
  });

  it('enqueueEvent returns duplicate without inserting when the search was already queued', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 5 }] });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'notify', 'search-1');

    expect(result).toEqual({ eventId: 5, duplicate: true });
    const inserts = mockExecute.mock.calls.filter((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watch_events'),
    );
    expect(inserts).toHaveLength(0);
  });

  it('enqueueEvent inserts invites with NULL search_id and no pre-check', async () => {
    // PRAGMA (placeholder) + open-invite SELECT (empty) + INSERT.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [], lastInsertRowid: 3 });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'invite');

    expect(result).toEqual({ eventId: 3, duplicate: false });
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockExecute.mock.calls[2][0].args[0]).toBeNull();
  });

  it('enqueueEvent collapses a second invite while one is still open', async () => {
    // PRAGMA + open-invite SELECT finds the still-queued first invite.
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 8 }] });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'invite');

    expect(result).toEqual({ eventId: 8, duplicate: true });
    const inserts = mockExecute.mock.calls.filter((call) =>
      String(call[0]?.sql ?? call[0]).includes('INSERT INTO watch_events'),
    );
    expect(inserts).toHaveLength(0);
  });

  it('enqueueEvent allows a new invite after the previous one settled', async () => {
    // PRAGMA + open-invite SELECT (sent/dropped do not block) + INSERT.
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockResolvedValueOnce({ rows: [], lastInsertRowid: 9 });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'invite');

    expect(result).toEqual({ eventId: 9, duplicate: false });
    const openCheck = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('FROM watch_events'),
    );
    // Only open (queued/claimed) invites block — settled history does not.
    expect(String(openCheck[0]?.sql ?? openCheck[0])).toContain(
      "status IN ('queued', 'claimed')",
    );
  });

  it('enqueueEvent throws on invalid kind/steamId/searchId', async () => {
    const { enqueueEvent } = require('./db');

    await expect(enqueueEvent(STEAM, 'email' as never)).rejects.toThrow(
      /event kind/,
    );
    await expect(enqueueEvent('short', 'notify')).rejects.toThrow(/17 digits/);
    await expect(enqueueEvent(STEAM, 'notify', '')).rejects.toThrow(
      /searchId/,
    );
    // All validation runs before any client is built (fail-fast, no wasted
    // connections — matters on serverless).
    expect(mockCreateClient).not.toHaveBeenCalled();
  });

  it('enqueueEvent treats a concurrent UNIQUE collision as duplicate (re-reads the winner)', async () => {
    // PRAGMA, pre-check SELECT (miss), INSERT (loses the race)...
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockRejectedValueOnce(
      new Error('UNIQUE constraint failed: watch_events.search_id'),
    );
    // ...re-read finds the winner's row.
    mockExecute.mockResolvedValueOnce({ rows: [{ id: 11 }] });

    const { enqueueEvent } = require('./db');
    const result = await enqueueEvent(STEAM, 'notify', 'search-race');

    expect(result).toEqual({ eventId: 11, duplicate: true });
  });

  it('enqueueEvent rethrows non-unique INSERT failures untouched', async () => {
    mockExecute.mockResolvedValueOnce({ rows: [] });
    mockExecute.mockRejectedValueOnce(new Error('db down'));

    const { enqueueEvent } = require('./db');
    await expect(enqueueEvent(STEAM, 'notify', 'search-race')).rejects.toThrow(
      'db down',
    );
  });

  it('claimNextQueuedEvents claims atomically via a single UPDATE...RETURNING', async () => {
    const rows = [
      {
        id: 1,
        search_id: 'search-1',
        steam_id: STEAM,
        kind: 'notify',
        status: 'claimed',
        created_at: '2026-09-08T00:00:00.000Z',
        claimed_at: '2026-09-08T00:00:01.000Z',
        sent_at: null,
      },
    ];
    mockExecute.mockResolvedValueOnce({ rows });

    const { claimNextQueuedEvents } = require('./db');
    const claimed = await claimNextQueuedEvents('notify', 5);

    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toEqual({
      id: 1,
      searchId: 'search-1',
      steamId: STEAM,
      kind: 'notify',
      status: 'claimed',
      createdAt: '2026-09-08T00:00:00.000Z',
      claimedAt: '2026-09-08T00:00:01.000Z',
      sentAt: null,
    });
    // Exactly one statement (PRAGMA aside): no read-then-write race window.
    const updates = mockExecute.mock.calls.filter((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watch_events'),
    );
    expect(updates).toHaveLength(1);
    expect(String(updates[0][0]?.sql ?? updates[0][0])).toContain('RETURNING');
    expect(updates[0][0].args).toEqual([expect.any(String), 'notify', 5]);
  });
  it('claimNextQueuedEvents clamps the limit, no-ops on zero, throws on NaN', async () => {
    const { claimNextQueuedEvents } = require('./db');

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(claimNextQueuedEvents('invite', 500)).resolves.toEqual([]);
    const update = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watch_events'),
    );
    expect(update[0].args[2]).toBe(100);

    // Zero capacity: returns [] without issuing the claim statement —
    // getClient is memoized from the call above, so zero executes at all.
    mockExecute.mockClear();
    await expect(claimNextQueuedEvents('invite', 0)).resolves.toEqual([]);
    expect(mockExecute).not.toHaveBeenCalled();

    await expect(claimNextQueuedEvents('invite', NaN)).rejects.toThrow(
      /finite/,
    );
    await expect(claimNextQueuedEvents('invite', -3)).resolves.toEqual([]);
  });

  it('claimNextQueuedEvents sorts by id (RETURNING order is not guaranteed)', async () => {
    const row = (id: number) => ({
      id,
      search_id: null,
      steam_id: STEAM,
      kind: 'invite',
      status: 'claimed',
      created_at: '2026-09-08T00:00:00.000Z',
      claimed_at: '2026-09-08T00:00:01.000Z',
      sent_at: null,
    });
    mockExecute.mockResolvedValueOnce({ rows: [row(9), row(3)] });

    const { claimNextQueuedEvents } = require('./db');
    const claimed = await claimNextQueuedEvents('invite', 10);

    expect(claimed.map((e: { id: number }) => e.id)).toEqual([3, 9]);
  });

  it('markEventSent flips a claimed row and bumps the cooldown clock atomically', async () => {
    mockBatch.mockResolvedValueOnce([{ rowsAffected: 1 }, { rowsAffected: 1 }]);

    const { markEventSent } = require('./db');
    await expect(markEventSent(9)).resolves.toBe(true);

    expect(mockBatch).toHaveBeenCalledTimes(1);
    const statements = mockBatch.mock.calls[0][0];
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("status = 'sent'");
    expect(statements[0].sql).toContain("status = 'claimed'");
    expect(statements[1].sql).toContain('last_notified_at');
    expect(statements[1].sql).toContain("kind = 'notify'");
    // The cooldown bump is guarded by the sent_at this call just wrote —
    // a duplicate markEventSent (first statement: 0 rows) turns the second
    // into a no-op instead of pushing the cooldown forward again.
    expect(statements[1].sql).toContain('sent_at = ?');
    expect(statements[1].args).toHaveLength(3);
  });

  it('markEventSent returns false when the row was never claimed', async () => {
    mockBatch.mockResolvedValueOnce([{ rowsAffected: 0 }, { rowsAffected: 0 }]);

    const { markEventSent } = require('./db');
    await expect(markEventSent(9)).resolves.toBe(false);
  });

  it('markEventDropped settles claimed rows only', async () => {
    const { markEventDropped } = require('./db');

    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(markEventDropped(9)).resolves.toBe(true);

    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(markEventDropped(9)).resolves.toBe(false);
  });

  it('resetStaleClaims requeues old claims and validates the window', async () => {
    const { resetStaleClaims } = require('./db');

    mockExecute.mockResolvedValueOnce({ rowsAffected: 3 });
    await expect(resetStaleClaims(30)).resolves.toBe(3);

    const update = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watch_events'),
    );
    expect(String(update[0]?.sql ?? update[0])).toContain("status = 'queued'");

    await expect(resetStaleClaims(0)).rejects.toThrow(/positive minutes/);
    await expect(resetStaleClaims(NaN)).rejects.toThrow(/positive minutes/);
  });

  it('isWithinCooldown reads the notify clock (open on missing/corrupt)', async () => {
    const { isWithinCooldown } = require('./db');

    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          last_notified_at: new Date(Date.now() - 3600000).toISOString(),
        },
      ],
    });
    await expect(isWithinCooldown(STEAM, 24)).resolves.toBe(true);

    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          last_notified_at: new Date(Date.now() - 25 * 3600000).toISOString(),
        },
      ],
    });
    await expect(isWithinCooldown(STEAM, 24)).resolves.toBe(false);

    mockExecute.mockResolvedValueOnce({ rows: [{ last_notified_at: null }] });
    await expect(isWithinCooldown(STEAM, 24)).resolves.toBe(false);

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(isWithinCooldown(STEAM, 24)).resolves.toBe(false);

    await expect(isWithinCooldown(STEAM, 0)).rejects.toThrow(
      /positive hours/,
    );
    await expect(isWithinCooldown('short', 24)).rejects.toThrow(/17 digits/);
  });

  it('listWatchedProfiles returns all rows oldest-first without filter', async () => {
    mockExecute.mockResolvedValueOnce({
      rows: [
        {
          steam_id: '76561198000000002',
          status: 'active',
          locale: 'en',
          requested_at: '2026-09-08T01:00:00.000Z',
          activated_at: '2026-09-08T02:00:00.000Z',
          last_notified_at: null,
        },
      ],
    });

    const { listWatchedProfiles } = require('./db');
    const rows = await listWatchedProfiles();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      steamId: '76561198000000002',
      status: 'active',
      locale: 'en',
    });
    const select = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('FROM watched_profiles'),
    );
    expect(String(select[0]?.sql ?? select[0])).not.toContain('WHERE');
  });

  it('listWatchedProfiles filters by status and rejects anything else', async () => {
    const { listWatchedProfiles } = require('./db');

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(listWatchedProfiles('pending')).resolves.toEqual([]);
    const select = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('FROM watched_profiles'),
    );
    expect(String(select[0]?.sql ?? select[0])).toContain(
      'WHERE status = ?',
    );
    expect(select[0].args).toEqual(['pending']);

    await expect(
      listWatchedProfiles('banned' as never),
    ).rejects.toThrow(/status filter/);
  });

  it('hints db:migrate when listWatchedProfiles hits a missing schema', async () => {
    // PRAGMA placeholder comes from beforeEach; the SELECT itself rejects.
    mockExecute.mockRejectedValueOnce(new Error('no such table: watched_profiles'));
    const { listWatchedProfiles } = require('./db');

    await expect(listWatchedProfiles()).rejects.toThrow(/db:migrate/);
  });

  it('hasOpenInviteEvent reports open invites (queued/claimed only)', async () => {
    const { hasOpenInviteEvent } = require('./db');

    mockExecute.mockResolvedValueOnce({ rows: [{ 1: 1 }] });
    await expect(hasOpenInviteEvent(STEAM)).resolves.toBe(true);

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(hasOpenInviteEvent(STEAM)).resolves.toBe(false);

    await expect(hasOpenInviteEvent('short')).rejects.toThrow(/17 digits/);
  });

  it('getWatchedProfile returns the mapped row or null', async () => {    const { getWatchedProfile } = require('./db');

    mockExecute.mockResolvedValueOnce({ rows: [watchRow()] });
    await expect(getWatchedProfile(STEAM)).resolves.toMatchObject({
      steamId: STEAM,
      status: 'pending',
    });

    mockExecute.mockResolvedValueOnce({ rows: [] });
    await expect(getWatchedProfile(STEAM)).resolves.toBeNull();

    await expect(getWatchedProfile('short')).rejects.toThrow(/17 digits/);
  });

  it('refreshWatchRequest touches only pending rows', async () => {
    const { refreshWatchRequest } = require('./db');

    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(refreshWatchRequest(STEAM)).resolves.toBe(true);

    const update = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watched_profiles'),
    );
    expect(String(update[0]?.sql ?? update[0])).toContain(
      "status = 'pending'",
    );

    mockExecute.mockResolvedValueOnce({ rowsAffected: 0 });
    await expect(refreshWatchRequest(STEAM)).resolves.toBe(false);

    await expect(refreshWatchRequest('short')).rejects.toThrow(/17 digits/);
  });

  it('refreshWatchRequest overwrites locale when valid, keeps it otherwise', async () => {
    const { refreshWatchRequest } = require('./db');

    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(refreshWatchRequest(STEAM, 'pt-BR')).resolves.toBe(true);
    const withLocale = mockExecute.mock.calls.find((call) =>
      String(call[0]?.sql ?? call[0]).includes('UPDATE watched_profiles'),
    );
    expect(withLocale[0].args).toEqual([expect.any(String), 'pt-BR', STEAM]);

    mockExecute.mockResolvedValueOnce({ rowsAffected: 1 });
    await expect(refreshWatchRequest(STEAM, 'pt-BR!!')).resolves.toBe(true);
    const kept = mockExecute.mock.calls
      .filter((call) =>
        String(call[0]?.sql ?? call[0]).includes('UPDATE watched_profiles'),
      )
      .pop();
    expect(kept[0].args).toEqual([expect.any(String), null, STEAM]);
  });
});