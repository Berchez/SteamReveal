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
 * location_guesses, cheater_results) are deleted explicitly per chunk in
 * the same transaction as their searches rows — never via ON DELETE
 * CASCADE / PRAGMA (unreliable over hrana HTTP) — and every chunk is
 * re-checked afterwards, aborting LOUDLY on leftovers. watch_events rows
 * have no FK by design (bot delivery log / ops audit) and survive unless
 * --with-watch-events is passed — they never render without a parent
 * search (the inbox joins searches).
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
import fs from 'fs';
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
  browser: string | null;
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
  '--browser',
  '--limit',
  '--expect',
]);
const BOOLEAN_FLAGS = new Set(['--all', '--confirm', '--with-watch-events']);

/**
 * Strict argv parsing: unknown flags, valueless flags, stray tokens, and
 * out-of-range values all reject (null) instead of widening the delete.
 * A typo like `--contry BR`, a single-dash `-country BR`, or a trailing
 * `--confirm --country` must never silently become a broader match on a
 * destructive tool — fail the run and print usage instead. Bare values
 * are only accepted right after their flag (consumed below); anywhere
 * else they are stray input and equally fatal.
 */
export const parseDeleteSearchesArgs = (argv: string[]): DeleteSearchesFilters | null => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(token)) continue;
      if (!VALUE_FLAGS.has(token)) return null;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return null;
      values.set(token, next);
      i += 1;
      continue;
    }
    // Single-dash lookalikes (`-country`) and any other dash-led token
    // are typos, not values (no value in this CLI starts with '-').
    // Anything else here is a stray bare token — also fatal, never
    // skipped: silently dropping input is how a delete widens.
    return null;
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
  const browserRaw = get('--browser');
  const browser =
    browserRaw === null
      ? null
      : browserRaw.length > 0 && browserRaw.length <= 35
        ? browserRaw
        : null;
  if (browserRaw !== null && browser === null) return null;
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
    browser,
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
    filters.locale === null &&
    filters.browser === null
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
 * date-only input expands to the full day in UTC. Datetimes MUST carry an
 * explicit timezone (`Z` or `±HH:MM`): a bare `2026-09-10T00:00:00`
 * parses as server-local time and would silently shift the destructive
 * window by the machine offset. Every accepted value is re-emitted via
 * `toISOString()` (raw offsets and millisecond-less forms compare wrong
 * lexicographically), and the date part is round-trip validated because
 * V8 rolls `2026-02-31` into March 3 instead of NaN. Prefer explicit `Z`
 * datetimes.
 */
export const normalizeDateBound = (
  raw: string | null,
  endOfDay: boolean,
): string | null => {
  if (raw === null) return null;
  // Calendar reality check on BOTH shapes (V8 rolls `2026-02-31` into
  // March instead of NaN — for date-only input the rollover would
  // silently widen the window into the next month).
  const dateMatch = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (!dateMatch) return null;
  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return endOfDay ? `${raw}T23:59:59.999Z` : `${raw}T00:00:00.000Z`;
  }
  if (!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(raw)) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
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
  if (filters.browser !== null) {
    clauses.push('m.requester_browser_language = ?');
    args.push(filters.browser);
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
     m.requester_locale AS locale, m.requester_browser_language AS browser
   ${SEARCHES_FROM_SQL}
   ${where}
   ORDER BY s.searched_at DESC, s.id DESC LIMIT ?`;

export const buildTotalSql = (where: string): string =>
  `SELECT COUNT(*) AS n ${SEARCHES_FROM_SQL} ${where}`;

// Deletes run in id-chunks (DELETE_CHUNK_IDS) so no statement ever nears
// SQLite's variable-number ceiling no matter how high --limit goes.
export const DELETE_CHUNK_IDS = 400;

const DELETE_CHILD_TABLES = [
  'profiles',
  'search_meta',
  'friends',
  'games_snapshot',
  'location_guesses',
  'cheater_results',
];

/**
 * Tables allowed to reference searches beyond the six deleted children:
 * watch_events (bot delivery/audit log, no FK by design) and
 * login_funnel_events.search_id (best-effort correlation, no FK by
 * design) intentionally survive a cleanup. Anything ELSE with a
 * search_id column is schema drift the hardcoded list does not know
 * about — the runtime probe below fails loudly instead of leaking it.
 */
const KNOWN_SEARCH_ID_AUDIT_TABLES = ['watch_events', 'login_funnel_events'];

const KNOWN_SEARCH_ID_TABLES = new Set([
  ...DELETE_CHILD_TABLES,
  ...KNOWN_SEARCH_ID_AUDIT_TABLES,
]);

/**
 * Explicit per-chunk deletes: every child table first, the searches rows
 * last, all in ONE client.batch() (single transaction — atomic per chunk).
 * This deliberately does NOT rely on ON DELETE CASCADE / PRAGMA
 * foreign_keys: over hrana HTTP each execute may ride a fresh stream
 * where a standalone PRAGMA never took, so trusting the pragma risks
 * silent orphans. The orphan re-check below stays as the second layer
 * (it catches schema drift, e.g. a CASCADE dropped by a bad migration).
 */
export const buildDeleteChunkStatements = (
  placeholders: string,
): Array<{ sql: string }> => [
  ...DELETE_CHILD_TABLES.map((table) => ({
    sql: `DELETE FROM ${table} WHERE search_id IN (${placeholders})`,
  })),
  { sql: `DELETE FROM searches WHERE id IN (${placeholders})` },
];

// Post-delete proof that the chunk actually landed everywhere: one SUM
// over the child tables per id-chunk (ORPHAN_CHECK_CHUNK keeps the 6×
// placeholder expansion well under the variable ceiling). Any leftover
// fails LOUDLY instead of rotting silently (schema drift, partial apply).
export const ORPHAN_CHECK_CHUNK_IDS = 150;

export const buildOrphanCountsSql = (placeholders: string): string =>
  `SELECT ${DELETE_CHILD_TABLES.map(
    (table) => `(SELECT COUNT(*) FROM ${table} WHERE search_id IN (${placeholders}))`,
  ).join(' + ')} AS orphans`;

export const chunkArray = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
};

export interface DeleteSearchesByIdsResult {
  deleted: number;
}

interface LibsqlLikeClient {
  execute: (
    stmt: { sql: string; args: (string | number)[] } | string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>;
  batch: (
    stmts: Array<{ sql: string; args: (string | number)[] }>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<any>;
}

/**
 * Deletes searches by id with their children, proving every step.
 * Exported (not inlined in main) so the full destructive flow — chunked
 * atomic deletes, per-chunk orphan proof, unknown-table probe — runs
 * against a real in-memory engine in delete-searches.test.ts instead of
 * only as mocked builders. Throws loudly on any leftover; callers exit 1.
 */
export const deleteSearchesByIds = async (
  client: LibsqlLikeClient,
  ids: string[],
  options: { withWatchEvents?: boolean } = {},
): Promise<DeleteSearchesByIdsResult> => {
  let deleted = 0;
  const chunks = chunkArray(ids, DELETE_CHUNK_IDS);
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c];
    const placeholders = chunk.map(() => '?').join(', ');
    // One batch = one transaction: children first, searches last —
    // atomic per chunk with no PRAGMA dependence (see
    // buildDeleteChunkStatements).
    // eslint-disable-next-line no-await-in-loop
    const results = await withTimeout(
      client.batch(
        buildDeleteChunkStatements(placeholders).map((statement) => ({
          sql: statement.sql,
          args: chunk,
        })),
      ),
      DELETE_TIMEOUT_MS,
      `delete-searches delete chunk ${c + 1}/${chunks.length}`,
    );
    deleted += Number(results[results.length - 1]?.rowsAffected ?? 0);
    // Prove the chunk actually landed everywhere before moving on.
    const orphanChunks = chunkArray(chunk, ORPHAN_CHECK_CHUNK_IDS);
    // eslint-disable-next-line no-await-in-loop
    const orphanResults: Array<{ rows: Array<{ orphans: unknown }> }> =
      await withTimeout(
        client.batch(
          orphanChunks.map((orphanChunk) => {
            const ph = orphanChunk.map(() => '?').join(', ');
            return {
              sql: buildOrphanCountsSql(ph),
              // Block-major: each of the 6 subselects gets the FULL id
              // list (id-major order only coincides for single-id chunks
              // and false-negatives the rest).
              args: DELETE_CHILD_TABLES.flatMap(() => orphanChunk),
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
      throw new Error(
        `${orphans} child rows survived in chunk ${c + 1}/${chunks.length} (schema drift? partial apply?) — aborting with later chunks untouched. Re-run the same command to retry the remainder.`,
      );
    }
  }
  if (options.withWatchEvents && ids.length > 0) {
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
  }
  await assertNoUnknownSearchIdReferences(client, ids);
  return { deleted };
};

/**
 * Schema-drift net: finds every table carrying a search_id column and
 * fails loudly when one is neither a deleted child nor a documented
 * audit survivor AND still references the deleted ids. A future migration
 * adding `search_id` anywhere else must make an explicit decision here
 * (delete with the chunk? keep as audit?) instead of leaking silently —
 * and the hardcoded DELETE_CHILD_TABLES can never silently go stale.
 */
export const assertNoUnknownSearchIdReferences = async (
  client: LibsqlLikeClient,
  ids: string[],
): Promise<void> => {
  const tablesResult = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
  );
  const unknown: string[] = [];
  for (const row of tablesResult.rows as Array<{ name: unknown }>) {
    const name = String(row.name);
    if (KNOWN_SEARCH_ID_TABLES.has(name)) continue;
    // eslint-disable-next-line no-await-in-loop
    const info = await client.execute(
      `PRAGMA table_info("${name.replace(/"/g, '""')}")`,
    );
    const hasSearchId = (info.rows as Array<{ name: unknown }>).some(
      (column) => column.name === 'search_id',
    );
    if (hasSearchId) unknown.push(name);
  }
  if (unknown.length === 0) return;
  let referencing = 0;
  for (const chunk of chunkArray(ids, ORPHAN_CHECK_CHUNK_IDS)) {
    const placeholders = chunk.map(() => '?').join(', ');
    // eslint-disable-next-line no-await-in-loop
    const counts: Array<{ rows: Array<{ n: unknown }> }> = await client.batch(
      unknown.map((table) => ({
        sql: `SELECT COUNT(*) AS n FROM "${table}" WHERE search_id IN (${placeholders})`,
        args: chunk,
      })),
    );
    referencing += counts.reduce(
      (sum: number, r) => sum + Number(r.rows[0]?.n ?? 0),
      0,
    );
  }
  if (referencing > 0) {
    throw new Error(
      `Tables outside the delete contract still reference the deleted searches: ${unknown.join(', ')} (${referencing} rows). Decide explicitly (delete with the chunk? keep as audit?) and update KNOWN_SEARCH_ID_TABLES — refusing to leak silently.`,
    );
  }
};

/**
 * Host-only view of DATABASE_URL for the pre-flight log: never the
 * token, never the full URL (both would leak the credential into
 * terminal scrollback/CI logs on a copy-paste).
 */
export const safeDatabaseHost = (databaseUrl: string): string => {
  try {
    const host = new URL(databaseUrl).host;
    return host.length > 0 ? host : '(local file database)';
  } catch {
    return '(unparseable DATABASE_URL)';
  }
};

/**
 * One audit line per --confirm run (ids + filters + timestamp). Pure for
 * testability; main appends it to .data/ (gitignored) BEFORE the deletes
 * so even a crashed run leaves the reviewed set recoverable.
 */
export const formatAuditEntry = (
  at: string,
  host: string,
  filters: DeleteSearchesFilters,
  ids: string[],
): string =>
  JSON.stringify({
    at,
    host,
    filters: {
      steamId: filters.steamId,
      since: filters.since,
      until: filters.until,
      country: filters.country,
      device: filters.device,
      locale: filters.locale,
      browser: filters.browser,
      limit: filters.limit,
      withWatchEvents: filters.withWatchEvents,
    },
    ids,
  });

export const AUDIT_LOG_PATH = '.data/delete-searches-audit.log';

const printUsageAndExit = (code: number): never => {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: scripts/delete-searches.ts [--steam-id 17DIGITS] [--since ISO] [--until ISO] [--country CC] [--device mobile|desktop] [--locale LOC] [--browser LANG] [--limit N>=1] [--expect N] [--all] [--with-watch-events] [--confirm]\n' +
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
    // Always say WHERE before touching anything: with several Turso
    // databases around (prod/staging/local), a wrong .env must be
    // visible in the output, not discovered after the delete.
    // eslint-disable-next-line no-console
    console.log(
      `Target database host: ${safeDatabaseHost(process.env.DATABASE_URL)}`,
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
    if (confirm && filters.matchAll && filters.expect === null) {
      // --all is the one unbounded shape: without --expect there is no
      // brake against a predicate that matches more than reviewed (clock
      // drift, a bot surge landing between dry-run and confirm). Predicated
      // runs keep --expect optional (limit already caps them).
      // eslint-disable-next-line no-console
      console.error(
        'DELETE-SEARCHES FAIL: --all --confirm requires --expect N (the reviewed count) — re-run dry-run first, then confirm with the count.',
      );
      client.close();
      process.exit(1);
    }
    const ids: string[] = preview.rows.map((row) => row.id as string);
    // Drift net BEFORE any delete (dry-run included): a table carrying
    // search_id that is neither a deleted child nor a documented audit
    // survivor, with rows tied to these ids, means the hardcoded contract
    // is stale — fail here, with nothing removed yet.
    try {
      // eslint-disable-next-line no-await-in-loop
      await assertNoUnknownSearchIdReferences(client, ids);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('DELETE-SEARCHES FAIL:', sanitizeError(error));
      client.close();
      process.exit(1);
    }
    if (!confirm) {
      if (filters.matchAll && filters.expect === null) {
        // eslint-disable-next-line no-console
        console.log(
          'Dry-run with --all and no --expect: consider adding --expect N ' +
            '(the listed count) so the --confirm run refuses a drifted set.',
        );
      }
      // eslint-disable-next-line no-console
      console.log('Dry-run: nothing deleted. Re-run with --confirm to delete.');
      client.close();
      process.exit(0);
    }
    if (ids.length === 0) {
      client.close();
      process.exit(0);
    }
    // Audit trail BEFORE the deletes: the reviewed id set + filters +
    // target host, appended to gitignored .data/ so even a crashed or
    // timed-out run leaves exactly what was approved recoverable.
    try {
      fs.mkdirSync('.data', { recursive: true });
      fs.appendFileSync(
        AUDIT_LOG_PATH,
        `${formatAuditEntry(
          new Date().toISOString(),
          safeDatabaseHost(process.env.DATABASE_URL ?? ''),
          filters,
          ids,
        )}\n`,
      );
    } catch {
      // eslint-disable-next-line no-console
      console.error(
        'DELETE-SEARCHES FAIL: could not write the audit log — refusing to delete without a trail.',
      );
      client.close();
      process.exit(1);
    }
    // NOTE: the preview and the deletes are separate snapshots — rows
    // recorded between the two land outside the captured id list, so a
    // concurrent search can never be deleted by accident. The reverse
    // (a listed row deleted elsewhere first) just deletes zero rows.
    let deleted = 0;
    try {
      // eslint-disable-next-line no-await-in-loop
      ({ deleted } = await deleteSearchesByIds(client, ids, {
        withWatchEvents: filters.withWatchEvents,
      }));
    } catch (error) {
      // A timeout here is ambiguous (the server may have applied the
      // DELETE after our deadline): re-count what is actually gone and
      // say so honestly instead of claiming success or failure blindly.
      // Recounts by predicate (not by id list), so there is no variable
      // ceiling and no truncation to misreport.
      // eslint-disable-next-line no-console
      console.error('DELETE-SEARCHES FAIL:', sanitizeError(error));
      try {
        const remaining: { rows: Array<{ n: unknown }> } = await withTimeout(
          client.execute({ sql: buildTotalSql(where), args }),
          DELETE_TIMEOUT_MS,
          'delete-searches recount',
        );
        // eslint-disable-next-line no-console
        console.log(
          `After the failure, ${Number(remaining.rows[0]?.n ?? '?')} of the predicate matches still exist — re-run the same command to finish; it only ever lists what is left.`,
        );
      } catch {
        // Recount is best-effort; the original error above is the signal.
      }
      client.close();
      process.exit(1);
    }
    // eslint-disable-next-line no-console
    console.log(
      `Deleted ${deleted} searches (children removed atomically per chunk and verified; watch_events audit rows ${filters.withWatchEvents ? 'also removed via --with-watch-events' : 'intentionally kept'}).`,
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
