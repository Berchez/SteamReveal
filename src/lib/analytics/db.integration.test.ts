/**
 * @jest-environment node
 */

/**
 * Real-SQL integration coverage for the Turso DAL.
 *
 * db.test.ts mocks @libsql/client, so it can never catch a typo'd column, a
 * broken FK, or a statement that only fails against a real engine. This file
 * runs the actual 001_init.sql schema on a real embedded libSQL engine
 * (`file::memory:`) and exercises recordSearch → getSearchRecords →
 * attachCheaterProbability for real — plus ON DELETE CASCADE, which is only
 * observable with a live database and FK enforcement on.
 *
 * Important: this file must NOT mock '@libsql/client'. The migration is
 * applied THROUGH db.ts's own memoized client (executeForTests), so the
 * schema, the writes and the reads all share one connection and one database.
 *
 * The module is never reset here: the client stays alive for the whole suite
 * and each test starts from a clean slate (beforeEach deletes searches, which
 * cascades into every child table and re-exercises the FK at the same time).
 */
import fs from 'fs';
import path from 'path';

import splitSqlStatements from './sqlStatements';

const MIGRATION_SQL = fs.readFileSync(
  path.join(__dirname, 'migrations', '001_init.sql'),
  'utf8',
);

// In-memory: one connection, one database, nothing to clean up afterwards.
const DATABASE_URL = 'file::memory:';

jest.setTimeout(30000);

type DbApi = {
  executeForTests: (
    sql: string,
    args?: (string | number | null)[],
  ) => Promise<{ rows: Record<string, unknown>[] }>;
  closeClientForTests: () => Promise<void>;
  recordSearch: typeof import('./db').recordSearch;
  getSearchRecords: typeof import('./db').getSearchRecords;
  attachCheaterProbability: typeof import('./db').attachCheaterProbability;
};

describe('analytics db integration against real libSQL', () => {
  const originalEnv = { ...process.env };
  let db: DbApi;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    delete process.env.DATABASE_TOKEN;

    db = require('./db') as DbApi;
    for (const statement of splitSqlStatements(MIGRATION_SQL)) {
      await db.executeForTests(statement);
    }
  });

  beforeEach(async () => {
    // Wipe the previous test's rows (cascades into every child table via FK).
    await db.executeForTests('DELETE FROM searches');
  });

  afterAll(async () => {
    await db.closeClientForTests();
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.DATABASE_TOKEN = originalEnv.DATABASE_TOKEN;
  });

  it('recordSearch → getSearchRecords round-trips the full record', async () => {
    const record = await db.recordSearch({
      profile: {
        steamId: '76561198000000000',
        nickname: 'IntegrationTester',
        cityId: 2786,
      },
      friends: [
        {
          steamId: '76561198000000001',
          nickname: 'F1',
          mutualCount: 3,
          probability: 87.5,
          countryCode: 'US',
        },
      ],
      gamesSnapshot: [{ name: 'Counter-Strike 2', playtimeHours: 120.5 }],
      locationGuess: [
        { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 0.93 },
      ],
      isCSActive: true,
      requesterLocale: 'pt',
      requesterCountry: 'BR',
      requesterBrowserLanguage: 'pt-BR',
      device: 'desktop',
      durationMs: 500,
    });

    const [read] = await db.getSearchRecords();

    expect(read.id).toBe(record.id);
    expect(read.searchedAt).toBe(record.searchedAt);
    expect(read.profile).toEqual({
      steamId: '76561198000000000',
      steamUrl: null,
      nickname: 'IntegrationTester',
      gcName: null,
      countryCode: null,
      stateCode: null,
      cityId: '2786',
    });
    expect(read.isCSActive).toBe(true);
    expect(read.device).toBe('desktop');
    expect(read.durationMs).toBe(500);
    expect(read.requesterLocale).toBe('pt');
    expect(read.requesterCountry).toBe('BR');
    expect(read.requesterBrowserLanguage).toBe('pt-BR');
    expect(read.friends).toEqual([
      {
        steamId: '76561198000000001',
        nickname: 'F1',
        gcName: null,
        mutualCount: 3,
        probability: 87.5,
        countryCode: 'US',
      },
    ]);
    expect(read.gamesSnapshot).toEqual([
      { name: 'Counter-Strike 2', playtimeHours: 120.5 },
    ]);
    expect(read.locationGuess).toEqual([
      { location: { cityName: 'Sao Paulo', countryCode: 'BR' }, probability: 0.93 },
    ]);
    expect(read.cheater).toBeNull();
  });

  it('attachCheaterProbability upserts on the real schema', async () => {
    const record = await db.recordSearch({
      profile: { steamId: '76561198000000000' },
      friends: [],
    });

    const attached = await db.attachCheaterProbability(record.id, {
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2026-09-05T00:00:00.000Z',
    });
    expect(attached).toBe(true);

    const [withCheater] = await db.getSearchRecords();
    expect(withCheater.cheater).toEqual({
      score: 72,
      bannedFriendsCount: 4,
      computedAt: '2026-09-05T00:00:00.000Z',
    });

    const reattached = await db.attachCheaterProbability(record.id, {
      score: 80,
      bannedFriendsCount: 2,
      computedAt: '2026-09-05T01:00:00.000Z',
    });
    expect(reattached).toBe(true);

    const [afterUpsert] = await db.getSearchRecords();
    expect(afterUpsert.cheater).toEqual({
      score: 80,
      bannedFriendsCount: 2,
      computedAt: '2026-09-05T01:00:00.000Z',
    });

    expect(
      await db.attachCheaterProbability('missing-search-id', {
        score: 1,
        bannedFriendsCount: null,
        computedAt: '2026-09-05T02:00:00.000Z',
      }),
    ).toBe(false);
  });

  it('ON DELETE CASCADE removes child rows from the real engine', async () => {
    const record = await db.recordSearch({
      profile: { steamId: '76561198000000000', nickname: 'CascadeMe' },
      friends: [{ steamId: '76561198000000001', nickname: 'F1' }],
      gamesSnapshot: [{ name: 'CS2', playtimeHours: 1 }],
      locationGuess: [
        { location: { cityName: 'X', countryCode: 'BR' }, probability: 0.5 },
      ],
      isCSActive: true,
    });
    await db.attachCheaterProbability(record.id, {
      score: 50,
      computedAt: '2026-09-05T00:00:00.000Z',
    });

    const childCount = async (table: string): Promise<number> => {
      const result = await db.executeForTests(
        `SELECT COUNT(*) AS n FROM ${table} WHERE search_id = ?`,
        [record.id],
      );
      return Number(result.rows[0].n);
    };

    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      expect(await childCount(table)).toBeGreaterThan(0);
    }

    await db.executeForTests('DELETE FROM searches WHERE id = ?', [record.id]);

    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      expect(await childCount(table)).toBe(0);
    }

    const remaining = await db.executeForTests('SELECT COUNT(*) AS n FROM searches');
    expect(Number(remaining.rows[0].n)).toBe(0);
  });
});