/**
 * @jest-environment node
 *
 * gcNameCache loads its state from disk once, at module import time, and
 * keeps it in a module-level Map — so most tests here need a FRESH module
 * instance with a controlled `fs` mock already in place before that import
 * happens. jest.resetModules() + a dynamic require() inside each test (or
 * inside a small helper) is what achieves that; a top-level `import` would
 * only ever see the module's very first load.
 */

const mockExistsSync = jest.fn();
const mockReadFileSync = jest.fn();
const mockWriteFile = jest.fn().mockResolvedValue(undefined);

// NOTE: deliberately NOT setting `__esModule: true` here. gcNameCache.ts
// does `import fs from 'fs'`, which with esModuleInterop compiles to
// something like `fs_1.default.existsSync(...)`. `__esModule: true` tells
// TS's interop helper "this mock is already a real ES module, use it
// as-is" — so it skips wrapping it in `{ default: ... }`, and
// `fs_1.default` ends up undefined. Leaving it off makes the interop
// helper wrap this object as `{ default: <this object> }`, matching how
// the real (CommonJS) `fs` module behaves.
jest.mock('fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
  promises: {
    writeFile: (...args: unknown[]) => mockWriteFile(...args),
  },
}));

type GcNameCacheModule = typeof import('./gcNameCache');

/**
 * Resets the module registry and re-requires gcNameCache, so the
 * module-level `cache` Map is rebuilt from whatever `fs` mock state is
 * configured at call time. Must be called AFTER setting up
 * mockExistsSync/mockReadFileSync for a given test, and the returned
 * module must be used instead of any previously-imported reference.
 */
const freshModule = (): GcNameCacheModule => {
  jest.resetModules();
  // eslint-disable-next-line global-require
  return require('./gcNameCache') as GcNameCacheModule;
};

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

describe('gcNameCache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
    mockWriteFile.mockResolvedValue(undefined);
  });

  describe('boot with no existing file', () => {
    it('starts empty and does not attempt to read a nonexistent file', () => {
      const { getCacheSize, getCachedGcName } = freshModule();

      expect(getCacheSize()).toBe(0);
      expect(getCachedGcName('76561198000000000')).toBeNull();
      expect(mockReadFileSync).not.toHaveBeenCalled();
    });
  });

  describe('get/set round-trip', () => {
    it('stores and retrieves a name, persisting to disk', async () => {
      const { getCachedGcName, setCachedGcName } = freshModule();

      setCachedGcName('76561198000000000', 'João Teste');
      // persistToDisk() is fire-and-forget; flush microtasks so the
      // (mocked) write actually resolves before we assert on it.
      await Promise.resolve();
      await Promise.resolve();

      const entry = getCachedGcName('76561198000000000');
      expect(entry?.name).toBe('João Teste');
      expect(mockWriteFile).toHaveBeenCalled();

      const [, writtenContent] = mockWriteFile.mock.calls[0] as [
        string,
        string,
      ];
      expect(JSON.parse(writtenContent)).toHaveProperty(
        '76561198000000000.name',
        'João Teste',
      );
    });

    it('stores and retrieves a confirmed null (not found) distinctly from a miss', () => {
      const { getCachedGcName, setCachedGcName } = freshModule();

      setCachedGcName('76561198000000001', null);

      const entry = getCachedGcName('76561198000000001');
      // A real cache HIT with name: null — must be distinguishable from
      // getCachedGcName returning null for "nothing cached at all".
      expect(entry).not.toBeNull();
      expect(entry?.name).toBeNull();
    });

    it('returns null for a Steam ID that was never cached', () => {
      const { getCachedGcName } = freshModule();

      expect(getCachedGcName('76561198000000099')).toBeNull();
    });
  });

  describe('TTL expiry', () => {
    it('treats an entry older than 90 days as a miss and evicts it', () => {
      const staleTimestamp = Date.now() - (NINETY_DAYS_MS + 1000);
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          '76561198000000000': { name: 'Old Name', cachedAt: staleTimestamp },
        }),
      );

      const { getCachedGcName, getCacheSize } = freshModule();

      // Expired entries left over from a previous run are pruned right
      // at load time.
      expect(getCacheSize()).toBe(0);
      expect(getCachedGcName('76561198000000000')).toBeNull();
    });

    it('keeps an entry that is within the TTL window', () => {
      const recentTimestamp = Date.now() - 1000;
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          '76561198000000000': {
            name: 'Fresh Name',
            cachedAt: recentTimestamp,
          },
        }),
      );

      const { getCachedGcName } = freshModule();

      expect(getCachedGcName('76561198000000000')?.name).toBe('Fresh Name');
    });
  });

  describe('malformed data on disk', () => {
    it('drops an entry with a non-numeric cachedAt instead of treating it as never-expiring', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          '76561198000000000': { name: 'Broken', cachedAt: 'not-a-number' },
        }),
      );

      const { getCachedGcName, getCacheSize } = freshModule();

      expect(getCacheSize()).toBe(0);
      expect(getCachedGcName('76561198000000000')).toBeNull();
    });

    it('drops an entry with a missing/invalid name field', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          '76561198000000000': { cachedAt: Date.now() },
        }),
      );

      const { getCacheSize } = freshModule();

      expect(getCacheSize()).toBe(0);
    });

    it('keeps valid entries while dropping invalid ones in the same file', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          good: { name: 'Valid Player', cachedAt: Date.now() },
          bad: { name: 'Invalid', cachedAt: 'not-a-number' },
        }),
      );

      const { getCachedGcName, getCacheSize } = freshModule();

      expect(getCacheSize()).toBe(1);
      expect(getCachedGcName('good')?.name).toBe('Valid Player');
      expect(getCachedGcName('bad')).toBeNull();
    });

    it('starts empty (without throwing) when the file contains invalid JSON', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue('{not valid json');

      const { getCacheSize } = freshModule();

      expect(getCacheSize()).toBe(0);
    });

    it('starts empty when the parsed JSON is not an object (e.g. an array)', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(JSON.stringify([1, 2, 3]));

      const { getCacheSize } = freshModule();

      expect(getCacheSize()).toBe(0);
    });
  });

  describe('prototype pollution safety', () => {
    it('storing a "__proto__" key does not pollute Object.prototype', () => {
      const { setCachedGcName, getCachedGcName } = freshModule();

      setCachedGcName('__proto__', 'Malicious');

      // eslint-disable-next-line no-new-object
      const innocentObject = {} as Record<string, unknown>;
      expect(innocentObject.name).toBeUndefined();
      expect(innocentObject.cachedAt).toBeUndefined();

      // The Map still treats it as an ordinary key, unaffected.
      expect(getCachedGcName('__proto__')?.name).toBe('Malicious');
    });

    it('loading a file with a "__proto__" key from disk does not pollute Object.prototype', () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        JSON.stringify({
          __proto__: { name: 'Malicious', cachedAt: Date.now() },
        }),
      );

      freshModule();

      // eslint-disable-next-line no-new-object
      const innocentObject = {} as Record<string, unknown>;
      expect(innocentObject.name).toBeUndefined();
    });
  });

  describe('clearCache', () => {
    it('empties the in-memory cache', () => {
      const { setCachedGcName, getCachedGcName, clearCache, getCacheSize } =
        freshModule();

      setCachedGcName('76561198000000000', 'Someone');
      expect(getCacheSize()).toBe(1);

      clearCache();

      expect(getCacheSize()).toBe(0);
      expect(getCachedGcName('76561198000000000')).toBeNull();
    });
  });
});
