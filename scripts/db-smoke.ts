import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import { isTransientInfraError } from '../src/lib/transientInfra';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withTimeout, isTimeoutError } = require('./smoke-timeout.cjs');

// Bounded: an unbounded batch() once hung `git push` FOREVER on a stalled
// Turso connection (no default timeout on the hrana transport). A stall is
// an environment problem — SKIP (exit 0) like any transport failure, never
// hang the push.
const DB_SMOKE_TIMEOUT_MS = 25_000;

// Proxy-less read-only Turso sanity check: table schema + row counts.
loadEnv();

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.log('DB SMOKE SKIPPED: DATABASE_URL not set');
  process.exit(0);
}

const tokenError = requireRemoteTursoToken(
  process.env.DATABASE_URL,
  process.env.DATABASE_TOKEN,
);
if (tokenError) {
  // eslint-disable-next-line no-console
  console.error(`DB SMOKE FAIL: ${tokenError}`);
  process.exit(1);
}

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_TOKEN || undefined,
});

// The core 1:1 search tables plus the login-funnel table (015), the popup
// table (016), the modal table (018) and the Ban Reveal tables (012 —
// targets, subscriptions and reveals are created atomically in one file,
// but asserting all three keeps a partial-DDL future honest): a deploy
// that skipped `pnpm run db:migrate` must fail THIS gate loudly (the write
// routes would degrade to per-request error logs otherwise), which is the
// exact scenario db:smoke exists to catch pre-push. The watch tables
// (002-011) predate this check and stay out of scope here — EXCEPT the two
// columns a real incident proved drift-prone
// (bot_heartbeat.disconnected_since was applied from dirty WIP without the
// column in Sep 2026; prod then logged `has no column named
// disconnected_since` every 60s while this gate stayed green): those get
// explicit PRAGMA assertions derived from EXPECTED_COLUMNS below.
// bot_heartbeat itself IS expected (so a missing table reads as a missing
// table, not just a missing column); the rest of the watch tables stay out
// of scope here.
const EXPECTED_TABLES = [
  'searches',
  'profiles',
  'search_meta',
  'friends',
  'games_snapshot',
  'location_guesses',
  'cheater_results',
  'login_funnel_events',
  'login_popup_events',
  'modal_events',
  'ban_watch_targets',
  'ban_watch_subscriptions',
  'ban_watch_reveals',
  'bot_heartbeat',
];

// Columns whose absence produced the Sep 2026 prod incident while every
// table existed: bot_heartbeat WITHOUT disconnected_since (011 dirty-WIP)
// and search_meta WITHOUT friends_visibility (014 never applied). A
// table-presence check alone stays green for both — assert the columns.
// To add a column, append ONE entry here; the batch statements and the
// result mapping below derive from this list.
const EXPECTED_COLUMNS: Array<{ table: string; column: string }> = [
  { table: 'bot_heartbeat', column: 'disconnected_since' },
  { table: 'search_meta', column: 'friends_visibility' },
];

// Tables needing a PRAGMA probe, derived (deduped, order-stable) — table
// names come from our own const above, never from user input, so inline
// interpolation is safe.
const PRAGMA_TABLES = Array.from(
  new Set(EXPECTED_COLUMNS.map(({ table }) => table)),
);

(async () => {
  const t0 = Date.now();

  // One db.batch() = one transaction: the counts come from the same snapshot,
  // so a recordSearch landing mid-run can't make searches != joined children
  // for a few ms and trip a false FAIL (same pattern as the DAL's
  // getSearchRecords).
  const [countRows, joinedProfilesRows, joinedMetaRows, tablesRows, ...pragmaResults] =
    await withTimeout(
      client.batch([
        { sql: 'SELECT COUNT(*) AS n FROM searches' },
        {
          sql: 'SELECT COUNT(*) AS n FROM searches s JOIN profiles p ON p.search_id = s.id',
        },
        {
          sql: 'SELECT COUNT(*) AS n FROM searches s JOIN search_meta m ON m.search_id = s.id',
        },
        { sql: "SELECT name FROM sqlite_master WHERE type = 'table'" },
        ...PRAGMA_TABLES.map((table) => ({
          sql: `PRAGMA table_info(${table})`,
        })),
      ]),
      DB_SMOKE_TIMEOUT_MS,
      'turso db:smoke batch',
    );

  const names = new Set(
    tablesRows.rows.map((r: { name: unknown }) => String(r.name)),
  );
  const missingTables = EXPECTED_TABLES.filter((t) => !names.has(t));

  const columnSets = new Map(
    PRAGMA_TABLES.map((table, index) => [
      table,
      new Set(
        pragmaResults[index].rows.map((r: { name: unknown }) =>
          String(r.name),
        ),
      ),
    ]),
  );
  const missingColumns = EXPECTED_COLUMNS.filter(
    ({ table, column }) => !columnSets.get(table)?.has(column),
  ).map(({ table, column }) => `${table}.${column}`);

  const checks = {
    searchesCount: Number(countRows.rows[0].n),
    joinedProfilesCount: Number(joinedProfilesRows.rows[0].n),
    joinedMetaCount: Number(joinedMetaRows.rows[0].n),
    schemaOk: missingTables.length === 0 && missingColumns.length === 0,
    missingTables,
    missingColumns,
    latencyMs: Date.now() - t0,
  };

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(checks, null, 2));

  // Schema present AND the 1:1 invariants intact: every search must have exactly
  // one profiles row AND one search_meta row (recordSearch writes parents +
  // children in one atomic batch, migrate-data does too, and nothing deletes a
  // search). A mismatch here means the table is desynced — fail the smoke
  // instead of only checking that the tables exist.
  const pass =
    checks.schemaOk &&
    checks.searchesCount === checks.joinedProfilesCount &&
    checks.searchesCount === checks.joinedMetaCount;
  if (!pass && checks.schemaOk) {
    // eslint-disable-next-line no-console
    console.error(
      `DB SMOKE CHECK FAILED: searches (${checks.searchesCount}) != joined profiles (${checks.joinedProfilesCount}) / joined search_meta (${checks.joinedMetaCount})`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(pass ? 'DB SMOKE PASS' : 'DB SMOKE FAIL');
  client.close();
  process.exit(pass ? 0 : 1);
})().catch((e) => {
  // A transport-level failure (Turso down, network blip) is an environment
  // problem, not an analytics regression — the pre-push hook runs this smoke,
  // and a reachable-Turso outage must not block pushes. A stall (timeout)
  // skips for the same reason: it proves nothing about schema/logic, and
  // hanging the push forever is the failure mode this guard exists to kill.
  // The predicate is the extended transient-infra one (transport + Turso
  // 5xx/S3), so a Turso-side outage skips exactly like a downed network.
  // Genuine schema/logic failures still FAIL loudly.
  if (isTransientInfraError(e) || isTimeoutError(e)) {
    // eslint-disable-next-line no-console
    console.log('DB SMOKE SKIPPED: Turso unreachable or stalled (timeout/transport-level failure)');
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error('DB SMOKE FAIL:', sanitizeError(e));
  process.exit(1);
});