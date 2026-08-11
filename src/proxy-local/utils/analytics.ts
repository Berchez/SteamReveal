import fs from 'fs/promises';
import path from 'path';

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
 */

const DB_HTML_PATH = path.resolve(__dirname, 'analytics.html');

const START_TAG = '<script type="application/json" id="db">';
const END_TAG = '</script>';

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
  device?: 'mobile' | 'desktop' | null;
  /** Top predicted location(s) for the searched profile. */
  locationGuess?: LocationGuess[] | null;
  /** Filled in later via attachCheaterProbability(), once the user requests it. */
  cheater?: CheaterProbabilityRecord | null;
  /** Wall-clock time, in ms, that the full search took client-side. */
  durationMs?: number | null;
}

type NewSearchInput = Omit<SearchRecord, 'id' | 'searchedAt' | 'cheater'>;

/**
 * Reads the JSON block embedded in the HTML and returns the
 * existing entries.
 */
const readEntries = async (): Promise<{
  html: string;
  entries: SearchRecord[];
  startIdx: number;
  endIdx: number;
}> => {
  let html: string;

  try {
    html = await fs.readFile(DB_HTML_PATH, 'utf-8');
  } catch (error) {
    throw new Error(
      `analytics.html not found at ${DB_HTML_PATH}. Make sure the generated file (with the <script id="db"> block) exists at this path before calling recordSearch().`,
    );
  }

  const startIdx = html.indexOf(START_TAG);

  if (startIdx === -1) {
    throw new Error('Start marker not found in analytics.html.');
  }

  const jsonStart = startIdx + START_TAG.length;

  const endIdx = html.indexOf(END_TAG, jsonStart);

  if (endIdx === -1) {
    throw new Error(
      'Closing marker for the data block not found in analytics.html.',
    );
  }

  const rawJson = html.slice(jsonStart, endIdx).trim() || '[]';

  let entries: SearchRecord[];

  try {
    entries = JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      'The data block in analytics.html contains invalid JSON — make sure no one manually edited the file incorrectly.',
    );
  }

  return { html, entries, startIdx: jsonStart, endIdx };
};

/**
 * Rewrites analytics.html by replacing only the JSON block.
 * It first writes to a temporary file and then renames it
 * to avoid corrupting the file if the process crashes
 * during the write.
 */
const writeEntries = async (
  html: string,
  jsonStart: number,
  jsonEnd: number,
  entries: SearchRecord[],
): Promise<void> => {
  // Escape "<" to prevent a malicious nickname/URL from prematurely
  // closing the <script> tag (e.g., a gcName containing "</script>").
  const serialized = JSON.stringify(entries, null, 2).replace(/</g, '\\u003c');

  const newHtml = `${html.slice(0, jsonStart)}
${serialized}
${html.slice(jsonEnd)}`;

  const tmpPath = `${DB_HTML_PATH}.tmp`;

  await fs.writeFile(tmpPath, newHtml, 'utf-8');
  await fs.rename(tmpPath, DB_HTML_PATH);
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
    const { html, entries, startIdx, endIdx } = await readEntries();

    const record: SearchRecord = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      searchedAt: new Date().toISOString(),
      cheater: null,
      ...input,
    };

    entries.push(record);

    await writeEntries(html, startIdx, endIdx, entries);

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
    const { html, entries, startIdx, endIdx } = await readEntries();

    const idx = entries.findIndex((e) => e.id === searchId);

    if (idx === -1) {
      return false;
    }

    entries[idx] = { ...entries[idx], cheater };

    await writeEntries(html, startIdx, endIdx, entries);

    return true;
  });

  writeQueue = task.then(() => undefined).catch(() => undefined);

  return task;
};

export default recordSearch;
