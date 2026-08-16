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
 * Reads just the JSON entries embedded in analytics.html on disk — the
 * <script id="db"> block. The surrounding HTML/CSS/JS shell is
 * intentionally ignored here (see the module doc comment above); only
 * writeEntries() decides what that shell looks like, and it always uses
 * analyticsDashboardTemplate.ts.
 *
 * Returns an empty array (not an error) if analytics.html doesn't exist
 * yet - first run, or the file was deleted/moved. Any
 * other read failure (permissions, I/O error...) still throws, since
 * that's not what this fallback is for.
 */
const readEntries = async (): Promise<SearchRecord[]> => {
  let html: string;

  try {
    html = await fs.readFile(DB_HTML_PATH, 'utf-8');
  } catch (error) {
    const isMissing = (error as { code?: string })?.code === 'ENOENT';

    if (!isMissing) {
      throw new Error(
        `Failed to read analytics.html at ${DB_HTML_PATH}: ${(error as Error).message}`,
      );
    }

    console.warn(
      `[Analytics] analytics.html not found at ${DB_HTML_PATH} — starting from an empty history. A fresh dashboard (from analyticsDashboardTemplate.ts) will be written on the next recordSearch()/attachCheaterProbability() call.`,
    );
    return [];
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

  try {
    return JSON.parse(rawJson);
  } catch (error) {
    throw new Error(
      'The data block in analytics.html contains invalid JSON — make sure no one manually edited the file incorrectly.',
    );
  }
};

/**
 * Rewrites analytics.html FROM SCRATCH: the dashboard shell always comes
 * from analyticsDashboardTemplate.ts, wrapped around the given entries —
 * see the module doc comment above for why. It first writes to a
 * temporary file and then renames it to avoid corrupting the file if the
 * process crashes during the write.
 */
const writeEntries = async (entries: SearchRecord[]): Promise<void> => {
  // Escape "<" to prevent a malicious nickname/URL from prematurely
  // closing the <script> tag (e.g., a gcName containing "</script>").
  const serialized = JSON.stringify(entries, null, 2).replace(/</g, '\\u003c');

  const newHtml = buildAnalyticsHtml(serialized);

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
