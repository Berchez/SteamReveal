/**
 * @jest-environment node
 */
import {
  buildOrphanCountsSql,
  buildPreviewSql,
  buildSearchesWhere,
  chunkArray,
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
    ]);
    expect(filters).not.toBeNull();

    const { where, args } = buildSearchesWhere(filters!);

    expect(where).toBe(
      'WHERE p.steam_id = ? AND UPPER(m.requester_country) = ? AND m.device = ?',
    );
    expect(args).toEqual(['76561198000000000', 'BR', 'desktop']);
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

  it('chunks id lists so no statement nears the variable ceiling', () => {
    expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunkArray([], 400)).toEqual([]);
    expect(chunkArray([1, 2], 10)).toEqual([[1, 2]]);
  });
});
