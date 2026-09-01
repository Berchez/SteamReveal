import fs from 'fs/promises';
import path from 'path';
import { buildAnalyticsHtml } from './analyticsDashboardTemplate';

/**
 * "Database" for Steam Friend Finder analytics.
 *
 * The data lives inside analytics.html itself, in a
 * dedicated block.
 *
 * This module runs on the LOCAL PROXY (same machine as the
 * scraper), not on Vercel — Vercel's filesystem is
 * read-only/ephemeral in production, so analytics.html would
 * never persist there. It's called from server.ts, which is
 * reached from the deployed site through the same Cloudflare
 * Tunnel already used for LOCAL_PROXY_URL.
 *
 * await recordSearch({
 *   profile: { steamId, steamUrl, nickname, gcName },
 *   friends: friendsList.map(f => ({
 *     steamId: f.steamId,
 *     nickname: f.nickname,
 *     gcName: f.gcName ?? null,
 *   })),
 * });
 *
 * ---------------------------------------------------------------------
 * On analytics.html's HTML/CSS/JS "shell" vs. its data
 * ---------------------------------------------------------------------
 * analyticsDashboardTemplate.ts is the ONLY source of truth for the
 * dashboard's markup, styling, and client-side behavior.
 * writeEntries() below always regenerates the ENTIRE analytics.html shell
 * from that template on every write — not just when the file happens to
 * be missing. Hand-editing analytics.html's HTML/CSS/JS directly no
 * longer has any lasting effect: the next recordSearch() or
 * attachCheaterProbability() call silently overwrites it. If you want to
 * change the dashboard, edit analyticsDashboardTemplate.ts (and see the
 * warning at the top of that file about how to do that safely).
 *
 * readEntries() (below), in contrast, deliberately does NOT care which
 * shell version is currently on disk — it only ever looks for the
 * <script id="db"> markers and parses whatever JSON is between them.
 * That's what makes it safe to keep improving the template over time:
 * old analytics.html files (written by an older template version, or
 * even hand-edited) still have their DATA read correctly; only the shell
 * around that data gets replaced on the next write.
 */

const DB_JSON_PATH = path.resolve(__dirname, 'analytics-data.json');
const LEGACY_DB_HTML_PATH = path.resolve(__dirname, 'analytics.html');

const START_TAG = '<script type="application/json" id="db">';
const END_TAG = '</script>';

const isMissingFileError = (error: unknown): boolean =>
  (error as { code?: string })?.code === 'ENOENT';

const writeAtomically = async (targetPath: string, contents: string): Promise<void> => {
  const tmpPath = `${targetPath}.tmp`;
  await fs.writeFile(tmpPath, contents, 'utf-8');
  await fs.rename(tmpPath, targetPath);
};

const backupIfExists = async (targetPath: string): Promise<void> => {
  try {
    await fs.readFile(targetPath, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) return;
    throw error;
  }

  const current = await fs.readFile(targetPath, 'utf-8');
  await writeAtomically(`${targetPath}.bak`, current);
};

export interface FriendRecord {
  steamId: string;
  nickname?: string | null;
  gcName?: string | null;
  /** Raw "close friend" score from the mutual-friend-density algorithm. */
  mutualCount?: number | null;
  /** Computed probability (0-100) that this is actually a close friend. */
  probability?: number | null;
  countryCode?: string | null;
}

export interface ProfileRecord {
  steamId: string;
  steamUrl?: string | null;
  nickname?: string | null;
  gcName?: string | null;
  countryCode?: string | null;
  stateCode?: string | null;
  cityId?: string | null;
}

export interface LocationGuess {
  location: string;
  probability: number;
}

export interface CheaterProbabilityRecord {
  score: number;
  bannedFriendsCount?: number | null;
  computedAt: string;
}

export interface SearchRecord {
  id: string;
  searchedAt: string;
  profile: ProfileRecord;
  friends: FriendRecord[];

  // ---- Everything below was added after the first version. ----
  /** Locale of whoever ran the search ('pt' | 'en' | ...). */
  requesterLocale?: string | null;
  /** Country of whoever ran the search (Vercel geo header, not the target's). */
  requesterCountry?: string | null;
  /** Browser language preference of whoever ran the search (navigator.language). */
  requesterBrowserLanguage?: string | null;
  device?: 'mobile' | 'desktop' | null;
  /** Top predicted location(s) for the searched profile. */
  locationGuess?: LocationGuess[] | null;
  /** Filled in later via attachCheaterProbability(), once the user requests it. */
  cheater?: CheaterProbabilityRecord | null;
  /** Wall-clock time, in ms, that the full search took client-side. */
  durationMs?: number | null;
}

type NewSearchInput = Omit<SearchRecord, 'id' | 'searchedAt' | 'cheater'>;

interface AnalyticsStore {
  read(): Promise<SearchRecord[]>;
  write(entries: SearchRecord[]): Promise<void>;
}

const readJsonEntries = async (filePath: string): Promise<SearchRecord[] | null> => {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const jsonText = String(raw ?? '').trim();
    if (!jsonText) return [];

    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed)) {
      throw new Error(`Data file at ${filePath} does not contain a JSON array.`);
    }

    return parsed as SearchRecord[];
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new Error(
      `Failed to read analytics data at ${filePath}: ${(error as Error).message}`,
    );
  }
};

const readLegacyHtmlEntries = async (): Promise<SearchRecord[]> => {
  let html: string;

  try {
    html = await fs.readFile(LEGACY_DB_HTML_PATH, 'utf-8');
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw new Error(
      `Failed to read analytics.html at ${LEGACY_DB_HTML_PATH}: ${(error as Error).message}`,
    );
  }

  const startIdx = html.indexOf(START_TAG);
  if (startIdx === -1) return [];

  const jsonStart = startIdx + START_TAG.length;
  const endIdx = html.indexOf(END_TAG, jsonStart);
  if (endIdx === -1) {
    throw new Error('Closing marker for the data block not found in analytics.html.');
  }

  const rawJson = html.slice(jsonStart, endIdx).trim() || '[]';

  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      'The data block in analytics.html contains invalid JSON — make sure no one manually edited the file incorrectly.',
    );
  }
};

const analyticsStore: AnalyticsStore = {
  async read(): Promise<SearchRecord[]> {
    const persisted = await readJsonEntries(DB_JSON_PATH);
    if (persisted !== null) return persisted;

    const legacyEntries = await readLegacyHtmlEntries();
    if (legacyEntries.length === 0) {
      console.warn(
        `[Analytics] No persisted analytics data found at ${DB_JSON_PATH} or ${LEGACY_DB_HTML_PATH}. Starting from an empty history.`,
      );
      return [];
    }

    await writeAtomically(DB_JSON_PATH, JSON.stringify(legacyEntries, null, 2));
    return legacyEntries;
  },

  async write(entries: SearchRecord[]): Promise<void> {
    const serializedEntries = JSON.stringify(entries, null, 2);
    await backupIfExists(DB_JSON_PATH);
    await writeAtomically(DB_JSON_PATH, serializedEntries);
  },
};

/**
 * Reads the persisted analytics records.
 *
 * The canonical datastore is analytics-data.json. analytics.html is kept
 * only as a generated view layer; legacy entries are migrated automatically
 * from the old embedded <script id="db"> block when needed.
 */
const readEntries = async (): Promise<SearchRecord[]> => analyticsStore.read();

/**
 * Persists the records and regenerates the dashboard shell from the current
 * template. Keeping the shell and the data separate makes future DB
 * migrations straightforward: the storage implementation can change without
 * rewriting the dashboard logic.
 */
const writeEntries = async (entries: SearchRecord[]): Promise<void> => {
  await analyticsStore.write(entries);

  const serializedEntries = JSON.stringify(entries, null, 2).replace(/</g, '\\u003c');
  const newHtml = buildAnalyticsHtml(serializedEntries);

  await backupIfExists(LEGACY_DB_HTML_PATH);
  await writeAtomically(LEGACY_DB_HTML_PATH, newHtml);
};

// Global queue used to serialize concurrent writes (both new searches and
// later cheater-probability attachments touch the same file).
let writeQueue: Promise<void> = Promise.resolve();

/**
 * Records a completed search (profile + found friends) in
 * analytics.html. Each call adds a NEW entry to the history
 * (it does not overwrite previous searches for the same profile).
 *
 * This is intentional: it allows us to see how frequently a profile
 * is searched and how its friend list changes over time.
 *
 * Returns the created record (including its `id`), so the caller can
 * later attach a cheater-probability score to this exact search via
 * attachCheaterProbability().
 */
export const recordSearch = (input: NewSearchInput): Promise<SearchRecord> => {
  const task = writeQueue.then(async () => {
    const entries = await readEntries();

    const record: SearchRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      searchedAt: new Date().toISOString(),
      cheater: null,
      ...input,
    };

    entries.push(record);

    await writeEntries(entries);

    return record;
  });

  // Make sure a failure in one call does not block subsequent calls.
  writeQueue = task.then(() => undefined).catch(() => undefined);

  return task;
};

/**
 * Attaches (or overwrites) the cheater-probability result for a search
 * that was already recorded. The cheater score is computed asynchronously,
 * only when/if the user clicks "cheater report" on the frontend — well
 * after the initial recordSearch() call — so it has to be a separate write.
 *
 * Returns false (without throwing) if the searchId isn't found, so the
 * caller can decide whether that's worth logging.
 */
export const attachCheaterProbability = (
  searchId: string,
  cheater: CheaterProbabilityRecord,
): Promise<boolean> => {
  const task = writeQueue.then(async () => {
    const entries = await readEntries();

    const idx = entries.findIndex((e) => e.id === searchId);

    if (idx === -1) {
      return false;
    }

    entries[idx] = { ...entries[idx], cheater };

    await writeEntries(entries);

    return true;
  });

  writeQueue = task.then(() => undefined).catch(() => undefined);

  return task;
};

export default recordSearch;
