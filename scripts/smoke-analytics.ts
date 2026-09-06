import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import { isTransportFailure } from '../src/lib/analytics/db';

// Points at the local Next dev server now — the analytics routes
// (recordAnalytics, recordAnalyticsCheater, analytics/dashboard) moved
// out of the proxy and run app-side, writing straight to Turso.
// loadEnv() populates process.env from .env (never overriding existing vars,
// so shell/CI exports win) — same semantics both smoke scripts and the
// ts-node admin scripts share via src/lib/env.ts.
loadEnv();

const BASE = process.env.SMOKE_ANALYTICS_BASE || 'http://localhost:3000';

if (!process.env.DATABASE_URL) {
  // eslint-disable-next-line no-console
  console.log('ANALYTICS SMOKE SKIPPED: DATABASE_URL not set');
  process.exit(0);
}

const tokenError = requireRemoteTursoToken(
  process.env.DATABASE_URL,
  process.env.DATABASE_TOKEN,
);
if (tokenError) {
  // eslint-disable-next-line no-console
  console.error(`ANALYTICS SMOKE FAIL: ${tokenError}`);
  process.exit(1);
}

const client = createClient({
  url: process.env.DATABASE_URL,
  authToken: process.env.DATABASE_TOKEN || undefined,
});

// The smoke hits live Next routes. A dev server isn't always running (e.g. a
// pre-push hook where Playwright started and then tore down its own server),
// and that's not an analytics failure — skip with a clear message instead of
// failing the caller with ECONNREFUSED.
const serverReachable = async (): Promise<boolean> => {
  try {
    const controller = new AbortController();
    // Generous cap: Next's dev homepage can take a few seconds to compile on
    // its first hit after idle. An absent server fails immediately anyway.
    const timer = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(BASE, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
};

// Turso may be reachable from THIS machine (the smoke's own client) but not
// from the dev server it's pointed at — however a local pre-flight probe
// covers the common cases (Turso outage / network blip) the same way the
// server check does: skip, don't fail the push. Genuine per-query errors (a
// missing schema, a bad SQL statement, an auth failure) surface as FAIL.
const tursoReachable = async (): Promise<boolean> => {
  try {
    await client.execute('SELECT 1');
    return true;
  } catch (error) {
    // Only transport-level failures (Turso down) justify skipping; non-transport
    // errors (auth, bad query) mean the DB is reachable but misconfigured —
    // throw so the main body's catch treats it as FAIL (no isTransportFailure
    // match) rather than silently skipping.
    if (isTransportFailure(error)) return false;
    throw error;
  }
};

const MARKER = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

(async () => {
  let exitCode = 1;
  let id: string | null = null;

  try {
    if (!(await serverReachable())) {
      // eslint-disable-next-line no-console
      console.log(`ANALYTICS SMOKE SKIPPED: no dev server reachable at ${BASE}`);
      client.close();
      process.exit(0);
    }

    if (!(await tursoReachable())) {
      // eslint-disable-next-line no-console
      console.log('ANALYTICS SMOKE SKIPPED: Turso unreachable (transport-level failure)');
      client.close();
      process.exit(0);
    }

    // 1. Record a fake search through the real Next route.
    const rec = await fetch(`${BASE}/api/recordAnalytics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        profile: { steamId: '76561198000000000', nickname: MARKER },
        friends: [],
        device: 'desktop',
        durationMs: 1,
      }),
    });
    const recBody = (await rec.json()) as { id?: string };
    if (!rec.ok || !recBody.id) {
      throw new Error(`record: HTTP ${rec.status} ${JSON.stringify(recBody)}`);
    }
    id = recBody.id;

    // 2. The row must exist in Turso, nickname intact (proves the write
    //    really landed in the DB, bypassing the proxy entirely).
    const row = await client.execute({
      sql: 'SELECT nickname FROM profiles WHERE search_id = ?',
      args: [id],
    });
    if (row.rows.length !== 1 || row.rows[0].nickname !== MARKER) {
      throw new Error(`record row missing/incorrect in Turso: ${JSON.stringify(row.rows)}`);
    }

    // 3. Attach a cheater score to that same search.
    const ch = await fetch(`${BASE}/api/recordAnalyticsCheater`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchId: id, score: 42, bannedFriendsCount: 1 }),
    });
    if (!ch.ok) throw new Error(`cheater: HTTP ${ch.status}`);

    const cheaterRow = await client.execute({
      sql: 'SELECT score FROM cheater_results WHERE search_id = ?',
      args: [id],
    });
    if (Number(cheaterRow.rows?.[0]?.score) !== 42) {
      throw new Error('cheater_score row missing/incorrect in Turso');
    }

    // 4. The dashboard (live-rendered from Turso) must show the record.
    //    Authentication goes through the x-analytics-key header (never a URL
    //    query string — a ?key= would leak the secret into access logs) when
    //    ANALYTICS_DASHBOARD_PASSWORD is configured.
    const dashHeaders: Record<string, string> = {};
    if (process.env.ANALYTICS_DASHBOARD_PASSWORD) {
      dashHeaders['x-analytics-key'] = process.env.ANALYTICS_DASHBOARD_PASSWORD;
    }
    const dash = await fetch(`${BASE}/api/analytics/dashboard`, {
      headers: dashHeaders,
    });
    const dashHtml = await dash.text();
    if (!dash.ok || !dashHtml.includes(MARKER)) {
      throw new Error(`dashboard: HTTP ${dash.status}, marker not rendered`);
    }

    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify(
        {
          recordedId: id,
          dashboardRendered: true,
        },
        null,
        2,
      ),
    );
    // eslint-disable-next-line no-console
    console.log('ANALYTICS SMOKE PASS');
    exitCode = 0;
  } catch (error) {
    if (isTransportFailure(error)) {
      // eslint-disable-next-line no-console
      console.log(
        'ANALYTICS SMOKE SKIPPED: Turso became unreachable mid-smoke (transport-level failure)',
      );
      client.close();
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error('ANALYTICS SMOKE FAIL:', sanitizeError(error));
    exitCode = 1;
  } finally {
    // Tear the smoke row down. Marker-scoped checks only (no global count
    // deltas) so concurrent real traffic on a shared DB can't cause false
    // negatives. Children first — SQLite foreign keys are enforced by the
    // app's client, so ordering is deterministic. Each delete is isolated:
    // one table failing (e.g. a blip) must not skip the remaining cleanup.
    if (id) {
      const childTables = [
        'cheater_results',
        'friends',
        'games_snapshot',
        'location_guesses',
        'search_meta',
        'profiles',
      ];
      let t = 0;
      while (t < childTables.length) {
        const tableName = childTables[t];
        try {
          // Sequential: children reference searches(id) via FK, so a parent
          // delete before its children is cleaned up would 500 (or worse,
          // violate the FK) on a strict connection.
          // eslint-disable-next-line no-await-in-loop
          await client.execute({
            sql: `DELETE FROM ${tableName} WHERE search_id = ?`,
            args: [id],
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`cleanup ${tableName} failed: ${sanitizeError(err)}`);
        }
        t += 1;
      }
      try {
        await client.execute({ sql: 'DELETE FROM searches WHERE id = ?', args: [id] });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`cleanup searches failed: ${sanitizeError(err)}`);
      }
    }
  }

  // Verify OUR row (and nothing else) was removed from EVERY table the smoke
  // touches — proves cleanup really happened, again without assuming exclusive
  // ownership of any table. Each delete above is isolated (a failure only
  // logs), so checking just one table (e.g. profiles) could PASS while a
  // sibling child table silently kept an orphan row; the sum across all seven
  // must be zero instead.
  try {
    const probeTables: Array<{ table: string; key: string }> = [
      { table: 'cheater_results', key: 'search_id' },
      { table: 'friends', key: 'search_id' },
      { table: 'games_snapshot', key: 'search_id' },
      { table: 'location_guesses', key: 'search_id' },
      { table: 'search_meta', key: 'search_id' },
      { table: 'profiles', key: 'search_id' },
      { table: 'searches', key: 'id' },
    ];
    let orphanedRows = 0;
    let p = 0;
    // Hard-coded table names (not user input) so interpolation is safe.
    while (p < probeTables.length) {
      const { table, key } = probeTables[p];
      try {
        // eslint-disable-next-line no-await-in-loop
        const probe = await client.execute({
          sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${key} = ?`,
          args: id ? [id] : ['__never-recorded__'],
        });
        orphanedRows += Number(probe.rows[0].n);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`cleanup probe ${table} failed: ${sanitizeError(error)}`);
        orphanedRows += 1;
      }
      p += 1;
    }
    if (id && orphanedRows !== 0) {
      // eslint-disable-next-line no-console
      console.error('ANALYTICS SMOKE FAIL: cleanup left the smoke row behind');
      exitCode = 1;
    }
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('ANALYTICS SMOKE FAIL:', sanitizeError(error));
    exitCode = 1;
  }

  client.close();
  process.exit(exitCode);
})().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('ANALYTICS SMOKE FAIL:', sanitizeError(error));
  process.exit(1);
});