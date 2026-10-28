import fs from 'fs';
import path from 'path';

/**
 * Local, file-backed cache for GamersClub name lookups, keyed by Steam ID.
 *
 * Deliberately separate from analytics.html: this holds no search history
 * or user-identifying data beyond "steamId -> gcName (or null)", so it's
 * safe to inspect, ship, or clear without touching real user analytics.
 *
 * Loaded into memory once at process boot; every write is persisted back
 * to disk so the cache survives restarts of the proxy-local process.
 */

// NOTE: this assumes proxy-local always runs via ts-node straight out of
// `src/` (see the `start:proxy-local` script in package.json), so
// `__dirname` here resolves to `src/proxy-local/utils/`. If this project
// ever switches to running a compiled `dist/` build, this path needs to
// move to something that doesn't depend on __dirname (e.g. an absolute
// path from process.cwd() or an env var), or dev/prod will silently read
// and write two different cache files.
const CACHE_FILE = path.resolve(__dirname, 'gcNameCache.data.json');
const TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

/**
 * Freshness window: an entry older than this is still a valid cache HIT
 * (it survives until the 90-day hard TTL), but it is no longer considered
 * FRESH — the next lookup is allowed to re-scrape GamersClub and refresh
 * the entry. Without this window a nickname change would only show up
 * after 90 days; with it, the name is refreshed at most once per player
 * per 30 days, and that single scrape happens on the local proxy (free),
 * not on Vercel (the route's own 3-day cache sits in front of it).
 */
const REFRESH_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Freshness window for a CONFIRMED miss ("GamersClub says this player has
 * no profile"). Shorter than the name window on purpose: a miss is the
 * answer most likely to be wrong — GamersClub's search endpoint sometimes
 * answers 2xx ("no player") for a player that DOES exist — and a wrong miss
 * is exactly what silently hides a GC name from a card.
 */
const MISS_REFRESH_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type CacheEntry = {
  name: string | null;
  cachedAt: number; // epoch ms
  /**
   * True only when the outcome was CONFIRMED by GamersClub itself (a name
   * parsed out of the profile page, or an explicit "no player" answer).
   * `false`/absent means UNCONFIRMED: the entry may be a failed scrape
   * frozen in place by an older build, so it must never be reported as a
   * confirmed miss and must be re-validated on the next allowed scrape.
   */
  confirmed?: boolean;
};

// Using a Map instead of a plain object indexed by steamId: steamId comes
// from a route param / request body that isn't validated beyond "is a
// string" before reaching here, and `obj[steamId] = ...` with a value like
// "__proto__" would pollute Object.prototype instead of setting a normal
// key. A Map has no such footgun.
type CacheShape = Map<string, CacheEntry>;

const isValidEntry = (value: unknown): value is CacheEntry =>
  typeof value === 'object' &&
  value !== null &&
  (typeof (value as CacheEntry).name === 'string' ||
    (value as CacheEntry).name === null) &&
  typeof (value as CacheEntry).cachedAt === 'number' &&
  Number.isFinite((value as CacheEntry).cachedAt) &&
  ((value as CacheEntry).confirmed === undefined ||
    typeof (value as CacheEntry).confirmed === 'boolean');

/**
 * Brings an entry loaded from disk up to the current schema.
 *
 * Legacy entries (written before the `confirmed` flag existed) carry no
 * proof of anything: a legacy NULL may be a transient failure that an older
 * build cached as a miss, so it is treated as UNCONFIRMED and re-validated
 * on the next allowed scrape. A legacy NAME is a positive signal — the
 * profile page was actually fetched and parsed — so it stays confirmed.
 */
const normalizeEntry = (entry: CacheEntry): CacheEntry => ({
  ...entry,
  confirmed: entry.confirmed ?? entry.name !== null,
});

/**
 * Loads the cache from disk, validating each entry's shape and dropping
 * anything malformed (e.g. from a hand-edited or truncated file) instead
 * of trusting JSON.parse's output blindly — a bad `cachedAt` in particular
 * could otherwise make an entry never expire (Date.now() - NaN = NaN,
 * and NaN > TTL_MS is always false).
 */
const loadFromDisk = (): CacheShape => {
  const map: CacheShape = new Map();

  try {
    if (!fs.existsSync(CACHE_FILE)) return map;
    const raw = fs.readFileSync(CACHE_FILE, 'utf-8');
    if (raw.trim() === '') return map;
    const parsed: unknown = JSON.parse(raw);

    if (typeof parsed !== 'object' || parsed === null) return map;

    Object.entries(parsed as Record<string, unknown>).forEach(
      ([steamId, entry]) => {
        if (isValidEntry(entry)) {
          map.set(steamId, normalizeEntry(entry));
        } else {
          console.warn(
            `[gcNameCache] Dropping malformed cache entry for ${steamId}`,
          );
        }
      },
    );
  } catch (err) {
    console.error(
      '[gcNameCache] Failed to load cache from disk, starting empty:',
      err,
    );
  }

  return map;
};

// In-memory store, populated once when this module is first imported.
// Expired entries left over from a previous run are pruned right away
// instead of only on next access, so the file doesn't carry dead weight
// indefinitely between reads.
const cache: CacheShape = loadFromDisk();
const now = Date.now();
Array.from(cache.entries()).forEach(([steamId, entry]) => {
  if (now - entry.cachedAt > TTL_MS) cache.delete(steamId);
});

// Serializes writes so concurrent cache updates (e.g. two lookups
// finishing close together) can't interleave and corrupt the file — same
// pattern as the request queue in rateLimit.ts.
let writeQueue: Promise<void> = Promise.resolve();

const persistToDisk = (): Promise<void> => {
  writeQueue = writeQueue.then(async () => {
    try {
      const asObject = Object.fromEntries(cache);
      await fs.promises.writeFile(
        CACHE_FILE,
        JSON.stringify(asObject, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error('[gcNameCache] Failed to persist cache to disk:', err);
    }
  });
  return writeQueue;
};

/**
 * Returns the cached entry for a Steam ID, or null on a cache miss or an
 * expired entry (which is also evicted from memory + disk as a side effect).
 */
export const getCachedGcName = (steamId: string): CacheEntry | null => {
  const entry = cache.get(steamId);
  if (!entry) return null;

  const age = Date.now() - entry.cachedAt;
  if (age > TTL_MS) {
    cache.delete(steamId);
    // Fire-and-forget: an expired-entry eviction doesn't need to block
    // the caller waiting on their (now-fresh) lookup. (Not using `void`
    // here — the project's eslint config disallows the void operator;
    // an un-awaited call is enough to express "fire and forget".)
    persistToDisk();
    return null;
  }

  return entry;
};

/**
 * True when the entry is past the freshness window and should be
 * re-scraped on the next allowed lookup. Entries past the hard TTL are
 * evicted by getCachedGcName before this is ever consulted.
 *
 * An UNCONFIRMED null is ALWAYS stale: it carries no proof that the player
 * really has no GamersClub profile, so the next allowed scrape must retry
 * it instead of serving "no profile" from the cache. A confirmed miss is
 * re-validated on the shorter MISS_REFRESH_MS window, and a name on the
 * regular REFRESH_MS window.
 */
export const isGcNameEntryStale = (entry: CacheEntry): boolean => {
  if (entry.name === null && entry.confirmed !== true) return true;
  const windowMs = entry.name === null ? MISS_REFRESH_MS : REFRESH_MS;
  return Date.now() - entry.cachedAt > windowMs;
};

/**
 * Stores a lookup result.
 *
 * A name is always a confirmed outcome, so `confirmed` defaults to true
 * for it. A null is NOT: the default is UNCONFIRMED, and only the caller
 * that actually got GamersClub's explicit "no player" answer may pass
 * `confirmed = true`. Never call this for timeouts, network errors, or
 * ambiguous parsing failures; see scrapeGamersClubName.ts for where each
 * outcome is decided.
 */
export const setCachedGcName = (
  steamId: string,
  name: string | null,
  confirmed: boolean = name !== null,
): void => {
  cache.set(steamId, { name, cachedAt: Date.now(), confirmed });
  persistToDisk();
};

// --- Test-only helpers ---
export const clearCache = (): void => {
  cache.clear();
};
export const getCacheSize = (): number => cache.size;
