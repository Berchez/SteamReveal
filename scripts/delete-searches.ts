#!/usr/bin/env node
/**
 * Owner-operated cleanup: delete recorded searches matching a predicate.
 *
 * Why this exists (and what it does NOT do): the dashboard cannot hide bot
 * traffic retroactively — no UA/IP is stored by design (see
 * src/lib/analytics/crawlerTraffic.ts), so suspect rows identified via
 * dashboard patterns (time bursts, odd locale/country/device combos) are
 * removed here by explicit predicate. Future bot hits are stopped at the
 * write path instead (POST /api/recordAnalytics skips crawler UAs).
 *
 * Dry-run by default (lists matches, deletes nothing); `--confirm`
 * executes the DELETE. Refuses to run unbounded: at least one predicate
 * (or --all) is required, unknown/valueless flags are rejected (a typo
 * must never widen a destructive match), and deletes run in id-chunks so
 * no statement nears SQLite's variable ceiling whatever --limit says.
 *
 * Children (profiles, search_meta, friends, games_snapshot,
 * location_guesses, cheater_results) go via ON DELETE CASCADE — and every
 * chunk is re-checked afterwards, aborting LOUDLY on leftovers instead of
 * trusting the FK pragma blindly. watch_events rows have no FK by design
 * (bot delivery log / ops audit) and survive unless --with-watch-events
 * is passed — they never render without a parent search (the inbox joins
 * searches).
 *
 * Usage:
 *   ts-node -O "{\"module\": \"commonjs\"}\" scripts/delete-searches.ts \
 *     --since 2026-09-01 --until 2026-09-10 --country XX [--confirm]
 *   scripts/delete-searches.ts --steam-id 76561198000000000 --confirm
 * Date-only bounds expand to the whole UTC day; datetimes must be ISO
 * with a T (prefer Z). --expect N aborts unless exactly N rows listed.
 *
 * Required env (same as db:smoke): DATABASE_URL (+ DATABASE_TOKEN for
 * remote Turso URLs). Exits 1 on logic errors AND on transport failures
 * (unlike the smokes: this is a manual destructive tool, never a gate —
 * silence here would be worse than noise).
 */
import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withTimeout } = require('./smoke-timeout.cjs');

const DELETE_TIMEOUT_MS = 25_000;
const DEFAULT_LIMIT = 500;

export interface DeleteSearchesFilters {
  steamId: string | null;
  since: string | null;
  until: string | null;
  country: string | null;
  device: string | null;
  locale: string | null;
  expect: number | null;
  matchAll: boolean;
  withWatchEvents: boolean;
  limit: number;
}

const VALUE_FLAGS = new Set([
  '--steam-id',
  '--since',
  '--until',
  '--country',
  '--device',
  '--locale',
  '--limit',
  '--expect',
]);
const BOOLEAN_FLAGS = new Set(['--all', '--confirm', '--with-watch-events']);

/**
 * Strict argv parsing: unknown flags, value-flags without a value, and
 * out-of-range values all reject (null) instead of widening the delete.
 * A typo like `--contry BR` or a trailing `--confirm --country` must never
 * silently become a broader match on a destructive tool — fail the run and
 * print usage instead.
 */
export const parseDeleteSearchesArgs = (argv: string[]): DeleteSearchesFilters | null => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    if (BOOLEAN_FLAGS.has(token)) continue;
    if (!VALUE_FLAGS.has(token)) return null;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) return null;
    values.set(token, next);
    i += 1;
  }
  const get = (flag: string): string | null => values.get(flag) ?? null;

  const steamId = get('--steam-id');
  if (steamId !== null && !/^\d{17}$/.test(steamId)) return null;
  const since = normalizeDateBound(get('--since'), false);
  if (get('--since') !== null && since === null) return null;
  const until = normalizeDateBound(get('--until'), true);
  if (get('--until') !== null && until === null) return null;
  const countryRaw = get('--country');
  const country =
    countryRaw === null
      ? null
      : /^[A-Za-z]{2}$/.test(countryRaw)
        ? countryRaw.toUpperCase()
        : null;
  if (countryRaw !== null && country === null) return null;
  const device = get('--device');
  if (device !== null && device !== 'mobile' && device !== 'desktop') return null;
  const localeRaw = get('--locale');
  const locale =
    localeRaw === null
      ? null
      : localeRaw.length > 0 && localeRaw.length <= 10
        ? localeRaw
        : null;
  if (localeRaw !== null && locale === null) return null;
  const limit = parsePositiveInt(get('--limit'), DEFAULT_LIMIT);
  if (limit === null) return null;
  const expectRaw = get('--expect');
  const expect =
    expectRaw === null
      ? null
      : /^\d+$/.test(expectRaw)
        ? parseInt(expectRaw, 10)
        : null;
  if (expectRaw !== null && expect === null) return null;

  const filters: DeleteSearchesFilters = {
    steamId,
    since,
    until,
    country,
    device,
    locale,
    expect,
    matchAll: argv.includes('--all'),
    withWatchEvents: argv.includes('--with-watch-events'),
    limit,
  };
  if (
    !filters.matchAll &&
    filters.steamId === null &&
    filters.since === null &&
    filters.until === null &&
    filters.country === null &&
    filters.device === null &&
    filters.locale === null
  ) {
    return null;
  }
  return filters;
};

const parsePositiveInt = (raw: string | null, fallback: number): number | null => {
  if (raw === null) return fallback;
  if (!/^\d+$/.test(raw)) return null;
  const parsed = parseInt(raw, 10);
  return parsed >= 1 ? parsed : null;
};

/**
 * Date bounds are compared lexicographically against `searched_at`, which
 * is always stored as full UTC ISO (`2026-09-10T00:00:13.840Z`). A bare
 * date would compare wrong (`--until 2026-09-10` excludes the whole 10th,
 * since every stored timestamp sorts after its own date prefix), so
 * date-only input expands to the full day in UTC. Anything that is not a
 * YYYY-MM-DD date or an ISO datetime with a `T` is rejected outright
 * (`Date.parse` alone accepts junk like `'1'` and local formats that
 * would silently mean something else). Prefer explicit `Z` datetimes.
 */
export const normalizeDateBound = (
  raw: string | null,
  endOfDay: boolean,
): string | null => {
  if (raw === null) return null;
  let iso = raw;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    iso = endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  } else if (!/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    return null;
  }
  return Number.isFinite(Date.parse(iso)) ? iso : null;
};

/**
 * One WHERE clause + args shared by the preview SELECT, the total COUNT
 * and the chunked DELETEs, so every step reasons about the same rows.
 */
export const buildSearchesWhere = (
  filters: DeleteSearchesFilters,
): { where: string; args: (string | number)[] } => {
  const clauses: string[] = [];
  const args: (string | number)[] = [];
  if (filters.steamId !== null) {
    clauses.push('p.steam_id = ?');
    args.push(filters.steamId);
  }
  if (filters.since !== null) {
    clauses.push('s.searched_at >= ?');
    args.push(filters.since);
  }
  if (filters.until !== null) {
    clauses.push('s.searched_at <= ?');
    args.push(filters.until);
  }
  if (filters.country !== null) {
    clauses.push('UPPER(m.requester_country) = ?');
    args.push(filters.country);
  }
  if (filters.device !== null) {
    clauses.push('m.device = ?');
    args.push(filters.device);
  }
  if (filters.locale !== null) {
    clauses.push('m.requester_locale = ?');
    args.push(filters.locale);
  }
  return {
    where: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    args,
  };
};

// Single FROM/JOIN fragment for preview + total (LEFT JOINs throughout:
// a search missing its profile row — only possible via hand edits, the
// DAL always writes both atomically — is still listed and still removed,
// it just renders NULL profile columns).
export const SEARCHES_FROM_SQL =
  'FROM searches s LEFT JOIN profiles p ON p.search_id = s.id LEFT JOIN search_meta m ON m.search_id = s.id';

export const buildPreviewSql = (where: string): string =>
  `SELECT s.id AS id, s.searched_at AS searched_at,
     p.steam_id AS steam_id, p.nickname AS nickname,
     m.requester_country AS country, m.device AS device,
     m.requester_locale AS locale
   ${SEARCHES_FROM_SQL}
   ${where}
   ORDER BY s.searched_at DESC, s.id DESC LIMIT ?`;

export const buildTotalSql = (where: string): string =>
  `SELECT COUNT(*) AS n ${SEARCHES_FROM_SQL} ${where}`;

// Deletes run in id-chunks (DELETE_CHUNK_IDS) so no statement ever nears
// SQLite's variable-number ceiling no matter how high --limit goes.
export const DELETE_CHUNK_IDS = 400;

export const buildDeleteChunkSql = (placeholders: string): string =>
  `DELETE FROM searches WHERE id IN (${placeholders})`;

const ORPHAN_CHECK_TABLES = [
  'profiles',
  'search_meta',
  'friends',
  'games_snapshot',
  'location_guesses',
  'cheater_results',
];

// Post-delete proof that ON DELETE CASCADE actually fired (the PRAGMA
// goes out as its own statement because SQLite ignores PRAGMA
// foreign_keys inside a transaction, and db.batch() is transactional —
// so instead of trusting the pragma, every chunk is re-checked and any
// leftover fails LOUDLY). One SUM over the child tables per id-chunk
// (ORPHAN_CHECK_CHUNK keeps the 6× placeholder expansion well under the
// variable ceiling).
export const ORPHAN_CHECK_CHUNK_IDS = 150;

export const buildOrphanCountsSql = (placeholders: string): string =>
  `SELECT ${ORPHAN_CHECK_TABLES.map(
    (table) => `(SELECT COUNT(*) FROM ${table} WHERE search_id IN (${placeholders}))`,
  ).join(' + ')} AS orphans`;

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

const printUsageAndExit = (code: number): never => {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: scripts/delete-searches.ts [--steam-id 17DIGITS] [--since ISO] [--until ISO] [--country CC] [--device mobile|desktop] [--locale LOC] [--limit N>=1] [--expect N] [--all] [--with-watch-events] [--confirm]\n' +
      'Dates accept YYYY-MM-DD (whole UTC day) or full ISO datetimes (prefer Z). At least one predicate (or --all) is required; unknown flags and valueless flags are rejected. Without --confirm this only lists matches (dry-run).',
  );
  process.exit(code);
};

async function main(): Promise<void> {
  const filters = parseDeleteSearchesArgs(process.argv.slice(2));
  if (filters === null) {
    printUsageAndExit(1);
    // Unreachable (usage printer exits) — keeps TS narrowing explicit
    // instead of relying on the never-return through the helper.
    process.exit(1);
  }

  loadEnv();
  if (!process.env.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('DELETE-SEARCHES FAIL: DATABASE_URL is not set.');
    process.exit(1);
  }
  const tokenError = requireRemoteTursoToken(
    process.env.DATABASE_URL,
    process.env.DATABASE_TOKEN,
  );
  if (tokenError) {
    // eslint-disable-next-line no-console
    console.error(`DELETE-SEARCHES FAIL: ${tokenError}`);
    process.exit(1);
  }

  const client = createClient({
    url: process.env.DATABASE_URL,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });
  const confirm = process.argv.includes('--confirm');

  try {
    // Own statement (NOT inside a batch/transaction): SQLite ignores
    // PRAGMA foreign_keys mid-transaction, so this must run standalone
    // to take effect — same pattern as the DAL's getClient().
    await withTimeout(
      client.execute('PRAGMA foreign_keys = ON'),
      DELETE_TIMEOUT_MS,
      'delete-searches pragma',
    );
    const { where, args } = buildSearchesWhere(filters);
    const [preview, total]: [
      { rows: Array<{ id: unknown }> },
      { rows: Array<{ n: unknown }> },
    ] = await withTimeout(
      client.batch([
        { sql: buildPreviewSql(where), args: [...args, filters.limit] },
        { sql: buildTotalSql(where), args },
      ]),
      DELETE_TIMEOUT_MS,
      'delete-searches preview',
    );
    const totalMatches = Number(total.rows[0]?.n ?? preview.rows.length);
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(preview.rows, null, 2));
    // eslint-disable-next-line no-console
    console.log(
      `Matched ${preview.rows.length} of ${totalMatches} searches (limit ${filters.limit}).` +
        (preview.rows.length < totalMatches
          ? ' Limit truncated the list — raise --limit to see/delete the rest.'
          : ''),
    );
    if (filters.expect !== null && preview.rows.length !== filters.expect) {
      // eslint-disable-next-line no-console
      console.error(
        `DELETE-SEARCHES FAIL: expected ${filters.expect} matches, listed ${preview.rows.length} — refusing to delete a different set than reviewed.`,
      );
      client.close();
      process.exit(1);
    }
    if (!confirm) {
      // eslint-disable-next-line no-console
      console.log('Dry-run: nothing deleted. Re-run with --confirm to delete.');
      client.close();
      process.exit(0);
    }
    const ids: string[] = preview.rows.map((row) => row.id as string);
    if (ids.length === 0) {
      client.close();
      process.exit(0);
    }
    // NOTE: the preview and the deletes are separate snapshots — rows
    // recorded between the two land outside the captured id list, so a
    // concurrent search can never be deleted by accident. The reverse
    // (a listed row deleted elsewhere first) just deletes zero rows.
    let deleted = 0;
    try {
      const chunks = chunkArray(ids, DELETE_CHUNK_IDS);
      for (let c = 0; c < chunks.length; c += 1) {
        const chunk = chunks[c];
        const placeholders = chunk.map(() => '?').join(', ');
        // eslint-disable-next-line no-await-in-loop
        const result = await withTimeout(
          client.execute({
            sql: buildDeleteChunkSql(placeholders),
            args: chunk,
          }),
          DELETE_TIMEOUT_MS,
          `delete-searches delete chunk ${c + 1}/${chunks.length}`,
        );
        deleted += Number(result.rowsAffected ?? 0);
        // Prove the cascade fired for THIS chunk before moving on: any
        // leftover fails loudly instead of rotting silently.
        const orphanChunks = chunkArray(chunk, ORPHAN_CHECK_CHUNK_IDS);
        // eslint-disable-next-line no-await-in-loop
        const orphanResults: Array<{ rows: Array<{ orphans: unknown }> }> =
          await withTimeout(
          client.batch(
            orphanChunks.map((orphanChunk) => {
              const ph = orphanChunk.map(() => '?').join(', ');
              return {
                sql: buildOrphanCountsSql(ph),
                args: orphanChunk.flatMap((id) =>
                  ORPHAN_CHECK_TABLES.map(() => id),
                ),
              };
            }),
          ),
          DELETE_TIMEOUT_MS,
          `delete-searches orphan check chunk ${c + 1}/${chunks.length}`,
        );
        const orphans = orphanResults.reduce(
          (sum: number, r) => sum + Number(r.rows[0]?.orphans ?? 0),
          0,
        );
        if (orphans > 0) {
          // eslint-disable-next-line no-console
          console.error(
            `DELETE-SEARCHES FAIL: ${orphans} child rows survived the cascade in chunk ${c + 1}/${chunks.length} (FK pragma did not take?) — aborting with later chunks untouched. Re-run the same command to retry the remainder.`,
          );
          client.close();
          process.exit(1);
        }
      }
    } catch (error) {
      // A timeout here is ambiguous (the server may have applied the
      // DELETE after our deadline): re-count what is actually gone and
      // say so honestly instead of claiming success or failure blindly.
      // eslint-disable-next-line no-console
      console.error('DELETE-SEARCHES FAIL:', sanitizeError(error));
      try {
        const remaining: { rows: Array<{ n: unknown }> } = await withTimeout(
          client.execute({
            sql: `SELECT COUNT(*) AS n FROM searches WHERE id IN (${ids.map(() => '?').join(', ')})`,
            args: ids.slice(0, 900),
          }),
          DELETE_TIMEOUT_MS,
          'delete-searches recount',
        );
        // eslint-disable-next-line no-console
        console.log(
          `After the failure, ${Number(remaining.rows[0]?.n ?? '?')} of the ${ids.length} listed ids still exist (recount capped at 900 ids) — re-run the same command to finish; it only ever lists what is left.`,
        );
      } catch {
        // Recount is best-effort; the original error above is the signal.
      }
      client.close();
      process.exit(1);
    }
    if (filters.withWatchEvents) {
      // Opt-in only: watch_events has no FK (delivery/audit log) and NULL
      // search_ids (invites/welcomes) never match IN — only rows tied to
      // the deleted searches go.
      const eventChunks = chunkArray(ids, DELETE_CHUNK_IDS);
      for (let c = 0; c < eventChunks.length; c += 1) {
        const chunk = eventChunks[c];
        // eslint-disable-next-line no-await-in-loop
        await withTimeout(
          client.execute({
            sql: `DELETE FROM watch_events WHERE search_id IN (${chunk.map(() => '?').join(', ')})`,
            args: chunk,
          }),
          DELETE_TIMEOUT_MS,
          `delete-searches watch_events chunk ${c + 1}/${eventChunks.length}`,
        );
      }
      // eslint-disable-next-line no-console
      console.log('Also removed watch_events rows tied to the deleted searches.');
    }
    // eslint-disable-next-line no-console
    console.log(
      `Deleted ${deleted} searches (children cascaded and verified; watch_events audit rows ${filters.withWatchEvents ? 'also removed via --with-watch-events' : 'intentionally kept'}).`,
    );
    client.close();
    process.exit(0);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('DELETE-SEARCHES FAIL:', sanitizeError(error));
    client.close();
    process.exit(1);
  }
}

// Guarded so the pure builders stay unit-testable by import without
// running the Turso round trips (same reason migrate-utils.ts never
// executes on require).
if (require.main === module) {
  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('DELETE-SEARCHES FAIL:', sanitizeError(error));
    process.exit(1);
  });
}
