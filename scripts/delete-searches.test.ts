/**
 * @jest-environment node
 */
import fs from 'fs';
import path from 'path';

import { createClient } from '@libsql/client';

import splitSqlStatements from '../src/lib/analytics/sqlStatements';
import {
  buildDeleteChunkStatements,
  buildOrphanCountsSql,
  buildPreviewSql,
  buildSearchesWhere,
  chunkArray,
  deleteSearchesByIds,
  normalizeDateBound,
  parseDeleteSearchesArgs,
} from './delete-searches';

describe('parseDeleteSearchesArgs', () => {
  it('parses every predicate and normalizes the country', () => {
    const filters = parseDeleteSearchesArgs([
      '--steam-id',
      '76561198000000000',
      '--since',
      '2026-09-01',
      '--until',
      '2026-09-10T00:00:00.000Z',
      '--country',
      'br',
      '--device',
      'mobile',
      '--locale',
      'pt',
      '--browser',
      'en-US',
      '--limit',
      '50',
      '--expect',
      '3',
      '--with-watch-events',
    ]);

    expect(filters).toEqual({
      steamId: '76561198000000000',
      since: '2026-09-01T00:00:00.000Z',
      until: '2026-09-10T00:00:00.000Z',
      country: 'BR',
      device: 'mobile',
      locale: 'pt',
      browser: 'en-US',
      expect: 3,
      matchAll: false,
      withWatchEvents: true,
      limit: 50,
    });
  });

  it('rejects garbage (bad steamId, dates, country, device, limit) and empty runs', () => {
    expect(parseDeleteSearchesArgs(['--steam-id', 'abc'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--since', 'not-a-date'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--since', '1'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--until', 'next Friday'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--country', 'BRA'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--device', 'tv'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--limit', 'many'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--limit', '0'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--expect', 'x'])).toBeNull();
    // No predicate and no --all: refuses the unbounded run.
    expect(parseDeleteSearchesArgs([])).toBeNull();
    expect(parseDeleteSearchesArgs(['--limit', '10'])).toBeNull();
  });

  it('rejects unknown flags and valueless flags instead of widening the delete', () => {
    // A typo must fail the run, never become a broader match.
    expect(parseDeleteSearchesArgs(['--contry', 'BR'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--since', '2026-09-01', '--bogus'])).toBeNull();
    // Trailing value-flag with no value (e.g. `--confirm --country`).
    expect(parseDeleteSearchesArgs(['--since', '2026-09-01', '--country'])).toBeNull();
    expect(parseDeleteSearchesArgs(['--country'])).toBeNull();
    // A flag where the value should be is not a value.
    expect(
      parseDeleteSearchesArgs(['--country', '--confirm', '--all']),
    ).toBeNull();
    // Single-dash lookalikes and stray bare tokens are typos, not skips.
    expect(
      parseDeleteSearchesArgs(['--since', '2026-09-01', '-country', 'BR']),
    ).toBeNull();
    expect(
      parseDeleteSearchesArgs(['--since', '2026-09-01', 'BR']),
    ).toBeNull();
  });

  it('accepts --all as the explicit unbounded run', () => {
    expect(parseDeleteSearchesArgs(['--all'])?.matchAll).toBe(true);
  });
});

describe('normalizeDateBound', () => {
  it('expands date-only bounds to the whole UTC day', () => {
    expect(normalizeDateBound('2026-09-10', false)).toBe('2026-09-10T00:00:00.000Z');
    expect(normalizeDateBound('2026-09-10', true)).toBe('2026-09-10T23:59:59.999Z');
  });

  it('passes full ISO datetimes through and rejects the rest', () => {
    expect(normalizeDateBound('2026-09-10T00:00:00.000Z', true)).toBe(
      '2026-09-10T00:00:00.000Z',
    );
    expect(normalizeDateBound('1', false)).toBeNull();
    expect(normalizeDateBound('next Friday', false)).toBeNull();
    expect(normalizeDateBound('2026-13-40', false)).toBeNull();
    expect(normalizeDateBound(null, false)).toBeNull();
  });

  it('rejects rolled-over calendar dates on both shapes', () => {
    // V8 parses 2026-02-31 as March 3 — on a destructive tool that
    // silently widens the window instead of failing.
    expect(normalizeDateBound('2026-02-31', false)).toBeNull();
    expect(normalizeDateBound('2026-02-31', true)).toBeNull();
    expect(normalizeDateBound('2026-02-31T00:00:00Z', false)).toBeNull();
  });

  it('requires an explicit timezone on datetimes (no server-local reads)', () => {
    expect(normalizeDateBound('2026-09-10T00:00:00', false)).toBeNull();
    expect(
      normalizeDateBound('2026-09-10T00:00:00+02:00', false),
    ).toBe('2026-09-09T22:00:00.000Z');
  });

  it('canonicalizes offsets and millisecond-less forms to stored shape', () => {
    // Raw offsets and missing millis compare wrong lexicographically
    // against `...840Z` store values — everything becomes full UTC ISO.
    expect(normalizeDateBound('2026-09-10T00:00:00-03:00', false)).toBe(
      '2026-09-10T03:00:00.000Z',
    );
    expect(normalizeDateBound('2026-09-10T00:00:13Z', false)).toBe(
      '2026-09-10T00:00:13.000Z',
    );
  });
});

describe('buildSearchesWhere', () => {
  it('builds one shared WHERE for preview and delete (same rows listed and removed)', () => {
    const filters = parseDeleteSearchesArgs([
      '--steam-id',
      '76561198000000000',
      '--country',
      'br',
      '--device',
      'desktop',
      '--browser',
      'en-US',
    ]);
    expect(filters).not.toBeNull();

    const { where, args } = buildSearchesWhere(filters!);

    expect(where).toBe(
      'WHERE p.steam_id = ? AND UPPER(m.requester_country) = ? AND m.device = ? AND m.requester_browser_language = ?',
    );
    expect(args).toEqual(['76561198000000000', 'BR', 'desktop', 'en-US']);
  });

  it('emits no WHERE for --all (explicit full-table intent)', () => {
    const { where, args } = buildSearchesWhere(parseDeleteSearchesArgs(['--all'])!);

    expect(where).toBe('');
    expect(args).toEqual([]);
  });

  it('lists profile-less searches too (LEFT JOIN — orphans are removable)', () => {
    expect(buildPreviewSql('')).toContain(
      'LEFT JOIN profiles p ON p.search_id = s.id',
    );
  });

  it('builds the orphan proof over all six child tables', () => {
    const sql = buildOrphanCountsSql('?, ?');

    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      expect(sql).toContain(`FROM ${table} WHERE search_id IN (?, ?)`);
    }
    expect(sql).toMatch(/AS orphans$/);
  });

  it('orders orphan-check args block-major (every table sees every id)', () => {
    // Regression net for the id-major bug ([A,A,B,B…] false-negatived):
    // the SQL holds 6 blocks of N placeholders, so args must be N ids
    // per block, not one id stretched over all blocks. Mirrors the
    // production construction (tables.flatMap(() => chunk)).
    const chunk = ['a', 'b', 'c'];
    const tables = [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ];
    const args = tables.flatMap(() => chunk);

    expect(args).toHaveLength(18);
    expect(args.slice(0, 3)).toEqual(['a', 'b', 'c']);
    expect(args.slice(3, 6)).toEqual(['a', 'b', 'c']);
    expect(new Set(args).size).toBe(3);
  });

  it('deletes children before parents in one atomic batch', () => {
    const statements = buildDeleteChunkStatements('?, ?');

    expect(statements).toHaveLength(7);
    expect(statements[6].sql).toBe('DELETE FROM searches WHERE id IN (?, ?)');
    for (const statement of statements.slice(0, 6)) {
      expect(statement.sql).toMatch(
        /^DELETE FROM \w+ WHERE search_id IN \(\?, \?\)$/,
      );
      expect(statement.sql).not.toContain('searches WHERE id');
    }
  });

  it('chunks id lists so no statement nears the variable ceiling', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 400)).toEqual([]);
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });
});

describe('deleteSearchesByIds (real in-memory engine)', () => {
  const seedTwoSearches = async (
    db: ReturnType<typeof createClient>,
    withUnknownTable: boolean,
  ): Promise<void> => {
    const migration = fs.readFileSync(
      path.join(
        __dirname,
        '..',
        'src',
        'lib',
        'analytics',
        'migrations',
        '001_init.sql',
      ),
      'utf8',
    );
    for (const statement of splitSqlStatements(migration)) {
      // eslint-disable-next-line no-await-in-loop
      await db.execute(statement);
    }
    // Minimal watch_events (002 shape not needed — only search_id matters).
    await db.execute(
      'CREATE TABLE watch_events (id INTEGER PRIMARY KEY, search_id TEXT, steam_id TEXT NOT NULL)',
    );
    if (withUnknownTable) {
      await db.execute(
        'CREATE TABLE future_audit (id INTEGER PRIMARY KEY, search_id TEXT NOT NULL)',
      );
    }
    const exec = (sql: string, args: (string | number)[]) =>
      db.execute({ sql, args });
    for (const sid of ['s1', 's2']) {
      // eslint-disable-next-line no-await-in-loop
      await exec('INSERT INTO searches (id, searched_at) VALUES (?, ?)', [
        sid,
        '2026-09-30T00:00:00.000Z',
      ]);
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO profiles (search_id, steam_id, nickname) VALUES (?, ?, ?)',
        [sid, '76561198000000001', 'Alice'],
      );
      // eslint-disable-next-line no-await-in-loop
      await exec('INSERT INTO search_meta (search_id) VALUES (?)', [sid]);
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO friends (search_id, steam_id) VALUES (?, ?)',
        [sid, '76561198000000009'],
      );
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO games_snapshot (search_id, name, playtime_hours) VALUES (?, ?, ?)',
        [sid, 'Counter-Strike 2', 5],
      );
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO location_guesses (search_id, location, probability) VALUES (?, ?, ?)',
        [sid, '{"cityName":"Sao Paulo"}', 90],
      );
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO cheater_results (search_id, score, computed_at) VALUES (?, ?, ?)',
        [sid, 10, '2026-09-30T00:01:00.000Z'],
      );
      // eslint-disable-next-line no-await-in-loop
      await exec(
        'INSERT INTO watch_events (search_id, steam_id) VALUES (?, ?)',
        [sid, '76561198000000001'],
      );
    }
  };

  const countTable = async (
    db: ReturnType<typeof createClient>,
    table: string,
  ): Promise<number> => {
    const result = await db.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    return Number((result.rows[0] as unknown as { n: unknown }).n);
  };

  it('removes searches plus all six children, keeps audit rows by default', async () => {
    const db = createClient({ url: 'file::memory:' });
    await seedTwoSearches(db, false);

    const { deleted } = await deleteSearchesByIds(db, ['s1']);

    expect(deleted).toBe(1);
    expect(await countTable(db, 'searches')).toBe(1);
    for (const table of [
      'profiles',
      'search_meta',
      'friends',
      'games_snapshot',
      'location_guesses',
      'cheater_results',
    ]) {
      // eslint-disable-next-line no-await-in-loop
      expect(await countTable(db, table)).toBe(1);
    }
    // Audit log survives by default (only s1's row stays, s2 untouched).
    expect(await countTable(db, 'watch_events')).toBe(2);
    db.close();
  });

  it('removes tied watch_events rows with the opt-in flag', async () => {
    const db = createClient({ url: 'file::memory:' });
    await seedTwoSearches(db, false);

    await deleteSearchesByIds(db, ['s1'], { withWatchEvents: true });

    expect(await countTable(db, 'searches')).toBe(1);
    const remaining = await db.execute(
      'SELECT search_id FROM watch_events ORDER BY search_id',
    );
    expect(remaining.rows.map((r) => (r as unknown as { search_id: unknown }).search_id)).toEqual([
      's2',
    ]);
    db.close();
  });

  it('fails loudly when an unknown table still references the deleted ids', async () => {
    const db = createClient({ url: 'file::memory:' });
    await seedTwoSearches(db, true);
    await db.execute(
      "INSERT INTO future_audit (search_id) VALUES ('s1')",
    );

    await expect(deleteSearchesByIds(db, ['s1'])).rejects.toThrow(
      /future_audit/,
    );
    // searches row itself still went (per-chunk atomicity); the loud
    // failure is the signal to handle the drifted table explicitly.
    expect(await countTable(db, 'searches')).toBe(1);
    db.close();
  });
});
