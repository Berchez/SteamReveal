// ---------------------------------------------------------------------
// Mocking fs/promises
// ---------------------------------------------------------------------
//
// Two things matter here:
//
// 1) analytics.ts resolves its DB path via
//    `path.resolve(__dirname, 'analytics.html')` — it always points at
//    the real analytics.html shipped next to this module, which in this
//    repo already holds real search history (Steam IDs, nicknames,
//    location guesses...). This test must never touch that file on
//    disk, so fs/promises is fully replaced with jest.fn()s and every
//    scenario below stays in-memory.
//
// 2) jest.mock() has to run before ANYTHING requires 'fs/promises' —
//    including analytics.ts's own `import fs from 'fs/promises'`.
//    TypeScript compiles `import` statements to require() calls hoisted
//    to the very top of a file, ahead of ordinary statements — this
//    project's transform doesn't include babel-plugin-jest-hoist (see
//    the require()-based "freshModule" pattern already used in
//    gcNameCache.test.ts), so a jest.mock() call placed after a static
//    `import { recordSearch } from './analytics'` runs too late:
//    analytics.ts has already grabbed the real fs/promises by then.
//    Using require() below (instead of `import`) for both fs/promises
//    and analytics.ts keeps them in real program order, after the mock
//    is registered.

// Shared object so both specifiers mocked below point at the exact
// same jest.fn() instances — mocking 'fs/promises' and
// 'node:fs/promises' with two SEPARATE factories would create two
// different mock objects, and we'd be back to the same
// "my mock isn't the one analytics.ts sees" problem.
const fsPromisesMocks = {
  readFile: jest.fn(),
  writeFile: jest.fn(),
  rename: jest.fn(),
};

// Mock BOTH the bare and the `node:`-prefixed specifier. Depending on
// how this project's transform compiles `import fs from 'fs/promises'`,
// analytics.ts's actual require() call may resolve under either
// string, and Jest treats them as separate registry entries — mocking
// only one leaves the other (real) implementation in place.
jest.mock('fs/promises', () => fsPromisesMocks);
jest.mock('node:fs/promises', () => fsPromisesMocks);

const mockedFs = require('fs/promises') as typeof fsPromisesMocks;
const { recordSearch, attachCheaterProbability } =
  require('./analytics') as typeof import('./analytics');

// Mirrors the private markers in analytics.ts. Duplicated here (not
// imported) so this test doesn't require exporting internals just to be
// testable.
const START_TAG = '<script type="application/json" id="db">';
const END_TAG = '</script>';

/** Pulls the JSON entries array out of a rendered analytics.html string. */
const extractEntries = (html: string): unknown[] => {
  const start = html.indexOf(START_TAG) + START_TAG.length;
  const end = html.indexOf(END_TAG, start);
  return JSON.parse(html.slice(start, end).trim() || '[]');
};

describe('recordSearch — analytics.html missing', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('starts from an empty history and still records the search when analytics.html is missing', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    mockedFs.writeFile.mockResolvedValueOnce(undefined);
    mockedFs.rename.mockResolvedValueOnce(undefined);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const record = await recordSearch({
      profile: { steamId: '76561190000000001' },
      friends: [],
    });

    // Warned instead of throwing.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('analytics.html not found'),
    );

    // Rebuilt the file through the normal tmp-write + rename path...
    expect(mockedFs.writeFile).toHaveBeenCalledTimes(1);
    expect(mockedFs.rename).toHaveBeenCalledTimes(1);

    // ...and it contains exactly the one new entry, appended to a fresh
    // (empty-history) dashboard built from analyticsDashboardTemplate.ts,
    // not a bare/ad-hoc stub.
    const writtenHtml = mockedFs.writeFile.mock.calls[0][1] as string;
    const entries = extractEntries(writtenHtml) as Array<{
      id: string;
      profile: { steamId: string };
    }>;

    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(record.id);
    expect(entries[0].profile.steamId).toBe('76561190000000001');
    expect(writtenHtml).toContain('Steam Friend Finder');

    warnSpy.mockRestore();
  });

  // Covers the other branch this diff introduced: readEntries() must keep
  // throwing (not silently recreate) for failures that are NOT "file is
  // missing" — e.g. permission or I/O errors — since those aren't what
  // the fallback is meant to paper over.
  it('still throws on non-ENOENT read failures instead of silently recreating the file', async () => {
    const permissionError = Object.assign(new Error('EACCES'), {
      code: 'EACCES',
    });
    mockedFs.readFile.mockRejectedValueOnce(permissionError);

    await expect(
      recordSearch({ profile: { steamId: '76561190000000002' }, friends: [] }),
    ).rejects.toThrow('Failed to read analytics.html');

    expect(mockedFs.writeFile).not.toHaveBeenCalled();
  });
});

describe('writeEntries — dashboard shell always comes from analyticsDashboardTemplate.ts', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  // This is the core guarantee of the "invert the source of truth" fix:
  // analyticsDashboardTemplate.ts is the ONLY place that determines what
  // the dashboard's HTML/CSS/JS looks like. Even if analytics.html on
  // disk currently has a different (e.g. stale, hand-edited, or written
  // by an older version of the template) shell, the very next write
  // replaces that shell with the current template's — while still
  // preserving every existing entry. Without this, a hand-edit to
  // analytics.html could silently drift from analyticsDashboardTemplate.ts
  // and then get "restored" to the wrong (stale) version the moment the
  // file went missing and got rebuilt — which is exactly the failure
  // mode that motivated this change.
  it('overwrites a stale on-disk shell with the current template, preserving existing entries', async () => {
    const preExistingEntry = {
      id: 'pre-existing-1',
      searchedAt: '2020-01-01T00:00:00.000Z',
      profile: { steamId: '76561190000000009' },
      friends: [],
      cheater: null,
    };

    const staleHtml =
      '<html><body>SOME OLD HAND-EDITED SHELL, DIFFERENT FROM THE CURRENT TEMPLATE' +
      `${START_TAG}\n${JSON.stringify([preExistingEntry])}\n${END_TAG}` +
      '</body></html>';

    mockedFs.readFile.mockResolvedValueOnce(staleHtml);
    mockedFs.writeFile.mockResolvedValueOnce(undefined);
    mockedFs.rename.mockResolvedValueOnce(undefined);

    await recordSearch({
      profile: { steamId: '76561190000000002' },
      friends: [],
    });

    const writtenHtml = mockedFs.writeFile.mock.calls[0][1] as string;

    // The stale shell is gone; the current template's shell is there instead.
    expect(writtenHtml).not.toContain('SOME OLD HAND-EDITED SHELL');
    expect(writtenHtml).toContain('Steam Friend Finder');

    // But nothing was lost: the pre-existing entry survived alongside
    // the new one.
    const entries = extractEntries(writtenHtml) as Array<{
      id: string;
      profile: { steamId: string };
    }>;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.profile.steamId)).toEqual(
      expect.arrayContaining(['76561190000000009', '76561190000000002']),
    );
  });
});

describe('attachCheaterProbability', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('returns false and does not write when the searchId is not found (e.g. analytics.html was reset)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockedFs.readFile.mockRejectedValueOnce(enoent);
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const attached = await attachCheaterProbability('some-old-search-id', {
      score: 42,
      computedAt: new Date().toISOString(),
    });

    expect(attached).toBe(false);
    expect(mockedFs.writeFile).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
