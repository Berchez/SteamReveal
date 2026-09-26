/**
 * @jest-environment node
 *
 * Sitemap DAL unit tests (P0 SEO): mirrors db.test.ts (offline
 * @libsql/client mock, node env) — success + edge + error cases for the
 * demand-ordered profile aggregates feeding generateSitemaps.
 */

const mockSitemapCreateClient = jest.fn();

jest.mock('@libsql/client', () => ({
  createClient: mockSitemapCreateClient,
}));

const mockSitemapExecute = jest.fn().mockResolvedValue({ rows: [] });
const mockSitemapBatch = jest.fn().mockResolvedValue({});
const mockSitemapClose = jest.fn();

function buildMockSitemapClient(): void {
  mockSitemapCreateClient.mockReturnValue({
    execute: mockSitemapExecute,
    batch: mockSitemapBatch,
    close: mockSitemapClose,
  } as never);
}

// Every first execute per fresh module is getClient's PRAGMA (cold start),
// so assertions below search all calls instead of indexing calls[0].
const executedSitemapSqls = (): string[] =>
  mockSitemapExecute.mock.calls.map((call) =>
    String(call[0]?.sql ?? call[0] ?? ''),
  );

const executedSitemapArgs = (): unknown[][] =>
  mockSitemapExecute.mock.calls.map((call) =>
    Array.isArray(call[0]?.args) ? (call[0].args as unknown[]) : [],
  );

describe('sitemap DAL', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    mockSitemapCreateClient.mockClear();
    mockSitemapExecute.mockClear();
    mockSitemapBatch.mockClear();
    mockSitemapClose.mockClear();
    buildMockSitemapClient();
    // Cold-start PRAGMA placeholder: the first execute of every fresh
    // module is getClient's PRAGMA, so it must never eat a test's queued
    // row (same convention as db.test.ts).
    mockSitemapExecute.mockResolvedValueOnce({ rows: [] });
    process.env.DATABASE_URL = 'libsql://demo-org.turso.io';
    process.env.DATABASE_TOKEN = 'secret-token';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('listPopularProfiles maps demand-ordered rows', async () => {
    mockSitemapExecute.mockResolvedValueOnce({
      rows: [
        {
          steam_id: '76561198000000001',
          nickname: 'SomePlayer',
          last_searched_at: '2026-09-25T00:00:00.000Z',
          search_count: 7,
        },
      ],
    });
    const { listPopularProfiles } = require('./db');
    await expect(listPopularProfiles(100, 0, 3)).resolves.toEqual([
      {
        steamId: '76561198000000001',
        nickname: 'SomePlayer',
        lastSearchedAt: '2026-09-25T00:00:00.000Z',
        searchCount: 7,
      },
    ]);
    expect(
      executedSitemapSqls().some((sql) => sql.includes('GROUP BY p.steam_id')),
    ).toBe(true);
    expect(
      executedSitemapSqls().some((sql) => sql.includes('HAVING COUNT(*) >= ?')),
    ).toBe(true);
    // Anti-abuse spread gate: back-to-back lookups alone never graduate.
    expect(
      executedSitemapSqls().some((sql) =>
        sql.includes('COUNT(DISTINCT date(s.searched_at)) >= ?'),
      ),
    ).toBe(true);
    // Latest nickname (not MAX): correlated subquery on max searched_at.
    expect(
      executedSitemapSqls().some((sql) =>
        sql.includes('ORDER BY s2.searched_at DESC'),
      ),
    ).toBe(true);
    // Malformed ids excluded pre-aggregation (exactly-17-digits guard).
    expect(
      executedSitemapSqls().some((sql) => sql.includes('NOT GLOB')),
    ).toBe(true);
    expect(
      executedSitemapSqls().some((sql) =>
        sql.includes('ORDER BY search_count DESC, last_searched_at DESC'),
      ),
    ).toBe(true);
    expect(
      executedSitemapSqls().some((sql) => sql.includes('LIMIT ? OFFSET ?')),
    ).toBe(true);
    expect(executedSitemapArgs()).toContainEqual([3, 2, 100, 0]);
  });

  it('listPopularProfiles validates and floors the day-spread gate', async () => {
    mockSitemapExecute.mockResolvedValue({ rows: [] });
    const { listPopularProfiles } = require('./db');
    await listPopularProfiles(10, 0, 3, 0);
    // minDays floors at 1 (single-day spread = threshold-only behavior).
    expect(executedSitemapArgs()).toContainEqual([3, 1, 10, 0]);
    await expect(
      listPopularProfiles(10, 0, 3, Number.NaN),
    ).rejects.toThrow(/finite/);
  });

  it('listPopularProfiles reads bigint counts like the native transport', async () => {
    mockSitemapExecute.mockResolvedValueOnce({
      rows: [
        {
          steam_id: '76561198000000001',
          nickname: 'SomePlayer',
          last_searched_at: '2026-09-25T00:00:00.000Z',
          search_count: BigInt(7),
        },
      ],
    });
    const { listPopularProfiles } = require('./db');
    await expect(listPopularProfiles(100, 0, 3)).resolves.toEqual([
      {
        steamId: '76561198000000001',
        nickname: 'SomePlayer',
        lastSearchedAt: '2026-09-25T00:00:00.000Z',
        searchCount: 7,
      },
    ]);
  });

  it('listPopularProfiles clamps the shard window (1..10000, offset >= 0)', async () => {
    mockSitemapExecute.mockResolvedValue({ rows: [] });
    const { listPopularProfiles } = require('./db');
    await listPopularProfiles(999999, -5, 0);
    // minSearches floors at 1, limit clamps at one shard, offset at 0
    // (minDays defaults to the 2-day spread gate).
    expect(executedSitemapArgs()).toContainEqual([1, 2, 10000, 0]);
    await expect(
      listPopularProfiles(Number.NaN, 0, 3),
    ).rejects.toThrow(/finite/);
    await expect(
      listPopularProfiles(10, Number.POSITIVE_INFINITY, 3),
    ).rejects.toThrow(/finite/);
  });

  it('listPopularProfiles skips malformed rows instead of nuking the shard', async () => {
    mockSitemapExecute.mockResolvedValueOnce({
      rows: [
        {
          steam_id: '76561198000000001',
          nickname: 'SomePlayer',
          last_searched_at: '2026-09-25T00:00:00.000Z',
          search_count: 7,
        },
        // Legacy vanity/unresolved id: no /player/ URL can resolve it.
        {
          steam_id: 'abctest',
          nickname: 'Ghost',
          last_searched_at: '2026-09-25T00:00:00.000Z',
          search_count: 9,
        },
        // Missing timestamp: sitemap lastmod must be real.
        {
          steam_id: '76561198000000002',
          nickname: null,
          last_searched_at: null,
          search_count: 4,
        },
      ],
    });
    const { listPopularProfiles } = require('./db');
    const rows = await listPopularProfiles(100, 0, 3);
    expect(
      rows.map((row: { steamId: string }) => row.steamId),
    ).toEqual(['76561198000000001']);
  });
});
