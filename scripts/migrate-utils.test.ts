/**
 * migrate-utils.buildStatements — column/arg pairing (the classic silent bug
 * class in a data import), so every statement is verified against the schema
 * order: root first, then profile, meta, children, cheater.
 */

import { buildStatements } from './migrate-utils';

import type { SearchRecord } from '../src/lib/analytics/types';

const fullRecord: SearchRecord = {
  id: '1788564056404-tzx2nt',
  searchedAt: '2026-09-04T20:00:00.000Z',
  profile: {
    steamId: '76561198000000000',
    steamUrl: 'https://steamcommunity.com/id/alice',
    nickname: 'Alice',
    gcName: 'GC-Alice',
    countryCode: 'BR',
    stateCode: 'SP',
    cityId: 2786,
  },
  friends: [
    {
      steamId: '76561198000000001',
      nickname: 'Bob',
      gcName: null,
      mutualCount: 12,
      // Real data is on a 0–100 scale (see analytics-archive; verified 0–91.2).
      probability: 87.5,
      countryCode: 'US',
    },
    {
      steamId: '76561198000000002',
      nickname: 'Carol',
    },
  ],
  gamesSnapshot: [
    { name: 'Counter-Strike 2', playtimeHours: 340 },
    { name: 'Portal 2', playtimeHours: 8 },
  ],
  isCSActive: true,
  requesterLocale: 'pt-BR',
  requesterCountry: 'BR',
  requesterBrowserLanguage: 'pt-BR',
  device: 'desktop',
  locationGuess: [
    {
      location: { cityName: 'Sao Paulo', countryName: 'Brazil', countryCode: 'BR' },
      probability: 72,
    },
  ],
  cheater: {
    score: 42,
    bannedFriendsCount: 3,
    computedAt: '2026-09-04T21:00:00.000Z',
  },
  durationMs: 900,
};

const findStmt = (
  stmts: ReturnType<typeof buildStatements>,
  sqlPart: string,
) => stmts.find((s) => s.sql.includes(sqlPart));

describe('buildStatements', () => {
  it('pairs columns and args for the root, profile, meta, children and cheater', () => {
    const stmts = buildStatements(fullRecord);

    const searches = stmts[0];
    expect(searches.sql).toContain('INSERT OR IGNORE INTO searches');
    expect(searches.args).toEqual(['1788564056404-tzx2nt', '2026-09-04T20:00:00.000Z']);

    const profile = findStmt(stmts, 'INSERT INTO profiles');
    expect(profile?.args).toEqual([
      '1788564056404-tzx2nt',
      '76561198000000000',
      'https://steamcommunity.com/id/alice',
      'Alice',
      'GC-Alice',
      'BR',
      'SP',
      '2786', // numeric cityId coerced to TEXT by nullableText
      1, // isCSActive -> toSqlBool
      900,
    ]);

    const meta = findStmt(stmts, 'INSERT INTO search_meta');
    expect(meta?.args).toEqual([
      '1788564056404-tzx2nt',
      'pt-BR',
      'BR',
      'pt-BR',
      'desktop',
    ]);

    const friendStms = stmts.filter((s) => s.sql.includes('INSERT INTO friends'));
    expect(friendStms).toHaveLength(2);
    expect(friendStms[0].args).toEqual([
      '1788564056404-tzx2nt',
      '76561198000000001',
      'Bob',
      null,
      12,
      87.5,
      'US',
    ]);
    expect(friendStms[1].args).toEqual([
      '1788564056404-tzx2nt',
      '76561198000000002',
      'Carol',
      null,
      null,
      null,
      null,
    ]);

    const gameStms = stmts.filter((s) => s.sql.includes('INSERT INTO games_snapshot'));
    expect(gameStms).toHaveLength(2);
    expect(gameStms[0].args).toEqual(['1788564056404-tzx2nt', 'Counter-Strike 2', 340]);

    const locStms = stmts.filter((s) => s.sql.includes('INSERT INTO location_guesses'));
    expect(locStms).toHaveLength(1);
    expect(locStms[0].args[0]).toBe('1788564056404-tzx2nt');
    expect(JSON.parse(locStms[0].args[1] as string)).toEqual({
      cityName: 'Sao Paulo',
      countryName: 'Brazil',
      countryCode: 'BR',
    });
    expect(locStms[0].args[2]).toBe(72);

    const cheater = findStmt(stmts, 'INSERT INTO cheater_results');
    expect(cheater?.args).toEqual([
      '1788564056404-tzx2nt',
      42,
      3,
      '2026-09-04T21:00:00.000Z',
    ]);
  });

  it('upserts parent rows but keeps the immutable searches identity OR IGNORE', () => {
    const stmts = buildStatements(fullRecord);

    // Parents (profiles, search_meta, cheater_results) reconcile to the source
    // payload on re-run via ON CONFLICT(search_id) DO UPDATE — a partial first
    // import whose parent rows already landed must not keep stale values.
    expect(findStmt(stmts, 'INSERT INTO profiles')?.sql).toContain(
      'ON CONFLICT(search_id) DO UPDATE',
    );
    expect(findStmt(stmts, 'INSERT INTO search_meta')?.sql).toContain(
      'ON CONFLICT(search_id) DO UPDATE',
    );
    expect(findStmt(stmts, 'INSERT INTO cheater_results')?.sql).toContain(
      'ON CONFLICT(search_id) DO UPDATE',
    );

    // searches owns the immutable id/searched_at identity — re-running must
    // never rewrite a search's creation time, so it stays plain OR IGNORE.
    const searches = findStmt(stmts, 'INSERT OR IGNORE INTO searches');
    expect(searches?.sql).toContain('INSERT OR IGNORE INTO searches');
    expect(searches?.sql).not.toContain('ON CONFLICT');
  });

  it('always deletes child rows before inserting (idempotent re-import)', () => {
    const stmts = buildStatements(fullRecord);

    const friendDeletes = stmts.filter((s) => s.sql.includes('DELETE FROM friends'));
    expect(friendDeletes).toHaveLength(1);
    expect(stmts.indexOf(friendDeletes[0])).toBeLessThan(
      stmts.findIndex((s) => s.sql.includes('INSERT INTO friends')),
    );

    expect(stmts.filter((s) => s.sql.includes('DELETE FROM games_snapshot'))).toHaveLength(1);
    expect(
      stmts.filter((s) => s.sql.includes('DELETE FROM location_guesses')),
    ).toHaveLength(1);
  });

  it('normalizes missing children arrays to "no inserts" instead of throwing', () => {
    // Legacy JSON may simply lack these keys — cast away the required types so
    // the undefined path is exercised (that's what the `?? []` guards exist for).
    const bare = {
      id: 'r2',
      searchedAt: '2026-09-04T20:00:00.000Z',
      profile: { steamId: '76561198000000000' },
    } as unknown as SearchRecord;

    expect(() => buildStatements(bare)).not.toThrow();
    const stmts = buildStatements(bare);

    expect(stmts.filter((s) => s.sql.includes('INSERT INTO friends'))).toHaveLength(0);
    expect(stmts.filter((s) => s.sql.includes('DELETE FROM friends'))).toHaveLength(1);

    expect(stmts.some((s) => s.sql.includes('games_snapshot'))).toBe(true);
    expect(stmts.some((s) => s.sql.includes('location_guesses'))).toBe(true);
    expect(stmts.filter((s) => s.sql.includes('cheater_results'))).toHaveLength(0);
  });

  it('surfaces the record identity when profile is missing (caller skips it)', () => {
    const broken = {
      id: 'r3',
      searchedAt: '2026-09-04T20:00:00.000Z',
      // no profile
    } as unknown as SearchRecord;

    expect(() => buildStatements(broken)).toThrow(TypeError);
  });

  it('skips child entries that would violate a NOT NULL / REAL constraint', () => {
    const mangled = {
      id: 'r4',
      searchedAt: '2026-09-04T20:00:00.000Z',
      profile: { steamId: '76561198000000000' },
      friends: [
        { steamId: '76561198000000001' },
        { steamId: '' },
        { steamId: '   ' },
        { steamId: null },
        { nickname: 'no-id-here' },
      ],
      gamesSnapshot: [
        { name: 'CS2', playtimeHours: 100 },
        { name: '', playtimeHours: 5 },
        { name: 'no-playtime' },
        { name: 'NaN playtime', playtimeHours: NaN },
      ],
      locationGuess: [
        { location: { cityName: 'SP' }, probability: 72 },
        { location: { cityName: 'no-probability' } },
        { probability: 0.5 },
        { location: null, probability: 0.5 },
      ],
    } as unknown as SearchRecord;

    expect(() => buildStatements(mangled)).not.toThrow();
    const stmts = buildStatements(mangled);

    const friendInserts = stmts.filter((s) => s.sql.includes('INSERT INTO friends'));
    const gameInserts = stmts.filter(
      (s) => s.sql.includes('INSERT INTO games_snapshot'),
    );
    const locationInserts = stmts.filter(
      (s) => s.sql.includes('INSERT INTO location_guesses'),
    );

    // Only the well-formed entries survive into statements.
    expect(friendInserts.map((s) => s.args[1])).toEqual(['76561198000000001']);
    expect(gameInserts.map((s) => s.args)).toEqual([
      ['r4', 'CS2', 100],
    ]);
    expect(JSON.parse(locationInserts[0].args[1] as string)).toEqual({
      cityName: 'SP',
    });

// The parent rows are still emitted so the rest of the record migrates.
    expect(
      stmts.some(
        (s) => s.sql.includes('INSERT INTO profiles') && s.args[0] === 'r4',
      ),
    ).toBe(true);
  });
});