import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import { isTransportFailure } from '../src/lib/analytics/db';

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

const EXPECTED_TABLES = [
  'searches',
  'profiles',
  'search_meta',
  'friends',
  'games_snapshot',
  'location_guesses',
  'cheater_results',
];

(async () => {
  const t0 = Date.now();

  // One db.batch() = one transaction: the counts come from the same snapshot,
  // so a recordSearch landing mid-run can't make searches != joined children
  // for a few ms and trip a false FAIL (same pattern as the DAL's
  // getSearchRecords).
  const [countRows, joinedProfilesRows, joinedMetaRows, tablesRows] = await client.batch([
    { sql: 'SELECT COUNT(*) AS n FROM searches' },
    {
      sql: 'SELECT COUNT(*) AS n FROM searches s JOIN profiles p ON p.search_id = s.id',
    },
    {
      sql: 'SELECT COUNT(*) AS n FROM searches s JOIN search_meta m ON m.search_id = s.id',
    },
    { sql: "SELECT name FROM sqlite_master WHERE type = 'table'" },
  ]);

  const names = new Set(tablesRows.rows.map((r) => String(r.name)));
  const missingTables = EXPECTED_TABLES.filter((t) => !names.has(t));

  const checks = {
    searchesCount: Number(countRows.rows[0].n),
    joinedProfilesCount: Number(joinedProfilesRows.rows[0].n),
    joinedMetaCount: Number(joinedMetaRows.rows[0].n),
    schemaOk: missingTables.length === 0,
    missingTables,
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
  // and a reachable-Turso outage must not block pushes. Genuine schema/logic
  // failures still FAIL loudly.
  if (isTransportFailure(e)) {
    // eslint-disable-next-line no-console
    console.log('DB SMOKE SKIPPED: Turso unreachable (transport-level failure)');
    process.exit(0);
  }
  // eslint-disable-next-line no-console
  console.error('DB SMOKE FAIL:', sanitizeError(e));
  process.exit(1);
});