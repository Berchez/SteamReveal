import {
  SEARCHER_HISTORY_CLEAR_SQL,
  SEARCHER_HISTORY_COUNT_SQL,
  parseSearcherHistoryArgs,
} from './delete-searcher-history';

describe('delete-searcher-history args', () => {
  it('accepts the full shape (id + expect + confirm)', () => {
    expect(
      parseSearcherHistoryArgs([
        '--searcher-steam-id',
        '76561198000000001',
        '--expect',
        '3',
        '--confirm',
      ]),
    ).toEqual({ searcherSteamId: '76561198000000001', expect: 3 });
  });

  it('accepts the id alone (dry-run)', () => {
    expect(
      parseSearcherHistoryArgs(['--searcher-steam-id', '76561198000000001']),
    ).toEqual({ searcherSteamId: '76561198000000001', expect: null });
  });

  it.each([
    ['missing id', ['--confirm']],
    ['short id', ['--searcher-steam-id', '123']],
    ['non-numeric id', ['--searcher-steam-id', '7656119800000000a']],
    ['unknown flag', ['--searcher-steam-id', '76561198000000001', '--all']],
    ['valueless flag', ['--searcher-steam-id']],
    ['stray token', ['76561198000000001']],
    ['single-dash lookalike', ['-searcher-steam-id', '76561198000000001']],
    ['bad expect', ['--searcher-steam-id', '76561198000000001', '--expect', 'x']],
  ])('rejects %s', (_name, argv) => {
    expect(parseSearcherHistoryArgs(argv as string[])).toBeNull();
  });

  it('scopes both statements to exactly one searcher (no widening predicate)', () => {
    // The erasure must never touch another viewer's links: both
    // statements carry the same single equality predicate.
    expect(SEARCHER_HISTORY_COUNT_SQL).toContain(
      'WHERE searcher_steam_id = ?',
    );
    expect(SEARCHER_HISTORY_CLEAR_SQL).toContain(
      'SET searcher_steam_id = NULL WHERE searcher_steam_id = ?',
    );
    expect(SEARCHER_HISTORY_CLEAR_SQL).not.toMatch(/DELETE/i);
  });
});
