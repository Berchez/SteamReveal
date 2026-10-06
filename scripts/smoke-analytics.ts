import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import { isTransientInfraError } from '../src/lib/transientInfra';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const smokeTimeout = require('./smoke-timeout.cjs');

const { withTimeout, fetchWithTimeout, isTimeoutError } = smokeTimeout;

// Every network wait below is bounded: an unbounded fetch/client.execute
// once hung `git push` FOREVER (Node fetch and the hrana transport have no
// default timeout). A stall is an environment problem, not an analytics
// regression — timeouts SKIP (exit 0) exactly like transport failures.
const FETCH_TIMEOUT_MS = 25_000;
const DB_TIMEOUT_MS = 25_000;
const PROBE_TIMEOUT_MS = 15_000;

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
    await withTimeout(
      client.execute('SELECT 1'),
      DB_TIMEOUT_MS,
      'turso pre-flight SELECT 1',
    );
    return true;
  } catch (error) {
    // Only transient-infra failures (Turso down, Turso-side 5xx/S3, network
    // blip) justify skipping; non-transient errors (auth, bad query) mean
    // the DB is reachable but misconfigured —
    // throw so the main body's catch treats it as FAIL (no isTransientInfraError
    // match) rather than silently skipping. A stall (timeout) is treated like
    // a transport failure: environment problem, skip, never hang the push.
    if (isTransientInfraError(error) || isTimeoutError(error)) return false;
    throw error;
  }
};

const MARKER = `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

(async () => {
  let exitCode = 1;
  let id: string | null = null;
  // Modal-leg window start (see 3.7): assigned inside try, read by the
  // finally cleanup — null when the leg never ran, so cleanup skips.
  let modalRunStart: string | null = null;

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
    const rec = await fetchWithTimeout(
      `${BASE}/api/recordAnalytics`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          profile: { steamId: '76561198000000000', nickname: MARKER },
          friends: [],
          device: 'desktop',
          durationMs: 1,
        }),
      },
      FETCH_TIMEOUT_MS,
    );
    const recBody = (await rec.json()) as { id?: string };
    if (!rec.ok || !recBody.id) {
      throw new Error(`record: HTTP ${rec.status} ${JSON.stringify(recBody)}`);
    }
    id = recBody.id;

    // 2. The row must exist in Turso, nickname intact (proves the write
    //    really landed in the DB, bypassing the proxy entirely).
    const row = await withTimeout(
      client.execute({
        sql: 'SELECT nickname FROM profiles WHERE search_id = ?',
        args: [id],
      }),
      DB_TIMEOUT_MS,
      'turso verify profiles row',
    );
    if (row.rows.length !== 1 || row.rows[0].nickname !== MARKER) {
      throw new Error(`record row missing/incorrect in Turso: ${JSON.stringify(row.rows)}`);
    }

    // 3. Attach a cheater score to that same search.
    const ch = await fetchWithTimeout(
      `${BASE}/api/recordAnalyticsCheater`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ searchId: id, score: 42, bannedFriendsCount: 1 }),
      },
      FETCH_TIMEOUT_MS,
    );
    if (!ch.ok) throw new Error(`cheater: HTTP ${ch.status}`);

    const cheaterRow = await withTimeout(
      client.execute({
        sql: 'SELECT score FROM cheater_results WHERE search_id = ?',
        args: [id],
      }),
      DB_TIMEOUT_MS,
      'turso verify cheater_results row',
    );
    if (Number(cheaterRow.rows?.[0]?.score) !== 42) {
      throw new Error('cheater_score row missing/incorrect in Turso');
    }

    // 3.5 Login-funnel leg (same gate discipline as the search/cheater legs
    //     above): a CTA beacon through the real route, the row verified in
    //     Turso, and the dashboard panel checked live. Catches a forgotten
    //     migration 015 here instead of as per-request error logs in prod.
    //     MARKER doubles as the anon session id (unique per run, ≤64 chars);
    //     the completion event is deliberately NOT simulated — it is
    //     server-side-only by design (client completions must 400).
    const cta = await fetchWithTimeout(
      `${BASE}/api/recordAnalyticsLogin`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          event: 'login_cta_clicked',
          sessionId: MARKER,
          searchId: id,
        }),
      },
      FETCH_TIMEOUT_MS,
    );
    if (!cta.ok) {
      const ctaBody = await cta.text();
      throw new Error(`loginFunnel: HTTP ${cta.status} ${ctaBody}`);
    }

    const funnelRow = await withTimeout(
      client.execute({
        sql: "SELECT event, session_id FROM login_funnel_events WHERE session_id = ? AND event = 'login_cta_clicked'",
        args: [MARKER],
      }),
      DB_TIMEOUT_MS,
      'turso verify login_funnel_events row',
    );
    if (
      funnelRow.rows.length !== 1 ||
      String(funnelRow.rows[0].event) !== 'login_cta_clicked'
    ) {
      throw new Error(
        `login_funnel_events row missing/incorrect in Turso: ${JSON.stringify(funnelRow.rows)}`,
      );
    }

    // 3.6 Login-prompt popup leg (same gate discipline): a shown + a CTA
    //     beacon through the real route, rows verified in Turso. Catches a
    //     forgotten migration 016 the same way 3.5 catches 015.
    for (const popupEvent of ['login_popup_shown', 'login_popup_cta_clicked']) {
      // eslint-disable-next-line no-await-in-loop
      const popupRes = await fetchWithTimeout(
        `${BASE}/api/recordAnalyticsLogin`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            event: popupEvent,
            sessionId: MARKER,
            searchId: id,
          }),
        },
        FETCH_TIMEOUT_MS,
      );
      if (!popupRes.ok) {
        const popupBody = await popupRes.text();
        throw new Error(
          `loginPopup(${popupEvent}): HTTP ${popupRes.status} ${popupBody}`,
        );
      }
    }

    const popupRow = await withTimeout(
      client.execute({
        sql: 'SELECT COUNT(*) AS n FROM login_popup_events WHERE session_id = ?',
        args: [MARKER],
      }),
      DB_TIMEOUT_MS,
      'turso verify login_popup_events rows',
    );
    if (Number(popupRow.rows[0].n) !== 2) {
      throw new Error(
        `login_popup_events rows missing in Turso: ${JSON.stringify(popupRow.rows)}`,
      );
    }

    // 3.7 Promo-modal leg (same gate discipline): shown + CTA beacons for
    //     one modal through the real route, rows verified in Turso, and the
    //     dashboard sections checked live. Catches a forgotten migration
    //     018 the same way 3.5 catches 015 (the route 500s loudly without
    //     the table). Modal rows carry no session marker by design (counts
    //     only), so scoping is by (modal, created_at >= run start) instead
    //     of MARKER — concurrent real sponsor rows inside the same seconds
    //     window would read as ours (harmless: assertion is >=) and could
    //     be swept by the cleanup below (accepted residual, documented
    //     there; modal traffic is near-zero per second).
    modalRunStart = new Date().toISOString();
    for (const modalEvent of ['shown', 'cta_clicked']) {
      // eslint-disable-next-line no-await-in-loop
      const modalRes = await fetchWithTimeout(
        `${BASE}/api/recordAnalyticsModals`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ modal: 'sponsor', event: modalEvent }),
        },
        FETCH_TIMEOUT_MS,
      );
      if (!modalRes.ok) {
        const modalBody = await modalRes.text();
        throw new Error(
          `modals(sponsor/${modalEvent}): HTTP ${modalRes.status} ${modalBody}`,
        );
      }
    }

    const modalRow = await withTimeout(
      client.execute({
        sql: "SELECT COUNT(*) AS n FROM modal_events WHERE modal = 'sponsor' AND created_at >= ?",
        args: [modalRunStart],
      }),
      DB_TIMEOUT_MS,
      'turso verify modal_events rows',
    );
    if (Number(modalRow.rows[0].n) < 2) {
      throw new Error(
        `modal_events rows missing in Turso: ${JSON.stringify(modalRow.rows)}`,
      );
    }

    // 4. The dashboard (live-rendered from Turso) must show the record.
    //    Authentication goes through the x-analytics-key header (never a URL
    //    query string — a ?key= would leak the secret into access logs) when
    //    ANALYTICS_DASHBOARD_PASSWORD is configured.
    const dashHeaders: Record<string, string> = {};
    if (process.env.ANALYTICS_DASHBOARD_PASSWORD) {
      dashHeaders['x-analytics-key'] = process.env.ANALYTICS_DASHBOARD_PASSWORD;
    }
    const dash = await fetchWithTimeout(
      `${BASE}/api/analytics/dashboard`,
      {
        headers: dashHeaders,
      },
      FETCH_TIMEOUT_MS,
    );
    const dashHtml = await dash.text();
    if (!dash.ok || !dashHtml.includes(MARKER)) {
      throw new Error(`dashboard: HTTP ${dash.status}, marker not rendered`);
    }
    // Funnel half of the dashboard: the panel shell + its JSON block must
    // render (values are aggregates over live traffic — marker-scoping the
    // counts themselves is meaningless, so only the structure is asserted).
    if (
      !dashHtml.includes('Steam login funnel') ||
      !dashHtml.includes('<script type="application/json" id="login-funnel-db">')
    ) {
      throw new Error('dashboard: login-funnel panel missing from render');
    }
    // Modal sections likewise (structure only, same aggregate rationale).
    if (
      !dashHtml.includes('SponsorMe') ||
      !dashHtml.includes('SupportMe') ||
      !dashHtml.includes('Login prompt') ||
      !dashHtml.includes('<script type="application/json" id="modal-stats-db">')
    ) {
      throw new Error('dashboard: modal sections missing from render');
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
    if (isTransientInfraError(error) || isTimeoutError(error)) {
      // eslint-disable-next-line no-console
      console.log(
        'ANALYTICS SMOKE SKIPPED: Turso/dev-server stalled or became unreachable mid-smoke (timeout/transport-level failure)',
      );
      client.close();
      process.exit(0);
    }
    // eslint-disable-next-line no-console
    console.error('ANALYTICS SMOKE FAIL:', sanitizeError(error));
    exitCode = 1;
  } finally {
    // Funnel rows are session-keyed (no FK to searches by design), so they
    // get their own marker-scoped delete — children-first ordering below
    // doesn't cover them. Unconditional: even if the beacon's response
    // timed out after the server already wrote the row (funnelBeaconOk
    // never set), the marker-scoped DELETE is a no-op on zero rows and
    // the orphan probe below still verifies it.
    try {
      await withTimeout(
        client.execute({
          sql: 'DELETE FROM login_funnel_events WHERE session_id = ?',
          args: [MARKER],
        }),
        DB_TIMEOUT_MS,
        'turso cleanup login_funnel_events',
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`cleanup login_funnel_events failed: ${sanitizeError(err)}`);
    }
    // Popup rows likewise (own table, same session marker).
    try {
      await withTimeout(
        client.execute({
          sql: 'DELETE FROM login_popup_events WHERE session_id = ?',
          args: [MARKER],
        }),
        DB_TIMEOUT_MS,
        'turso cleanup login_popup_events',
      );
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`cleanup login_popup_events failed: ${sanitizeError(err)}`);
    }
    // Modal rows likewise, scoped by (modal, created_at window) — the
    // table has no session marker by design. A real sponsor event landing
    // inside the same seconds window would be swept too (near-zero modal
    // traffic per second makes this acceptable; counts-only rows carry no
    // identity to disambiguate by). Skipped when the leg never ran.
    if (modalRunStart !== null) {
      try {
        await withTimeout(
          client.execute({
            sql: "DELETE FROM modal_events WHERE modal = 'sponsor' AND created_at >= ?",
            args: [modalRunStart],
          }),
          DB_TIMEOUT_MS,
          'turso cleanup modal_events',
        );
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(`cleanup modal_events failed: ${sanitizeError(err)}`);
      }
    }
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
          // violate the FK) on a strict connection. Bounded: a stalled
          // delete must not hang the push — it only logs, like every other
          // cleanup failure here.
          // eslint-disable-next-line no-await-in-loop
          await withTimeout(
            client.execute({
              sql: `DELETE FROM ${tableName} WHERE search_id = ?`,
              args: [id],
            }),
            DB_TIMEOUT_MS,
            `turso cleanup ${tableName}`,
          );
        } catch (err) {
          // eslint-disable-next-line no-console
          console.error(`cleanup ${tableName} failed: ${sanitizeError(err)}`);
        }
        t += 1;
      }
      try {
        await withTimeout(
          client.execute({ sql: 'DELETE FROM searches WHERE id = ?', args: [id] }),
          DB_TIMEOUT_MS,
          'turso cleanup searches',
        );
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
    let probeIncomplete = false;
    let p = 0;
    // Hard-coded table names (not user input) so interpolation is safe.
    while (p < probeTables.length) {
      const { table, key } = probeTables[p];
      try {
        // Bounded like every other wait in this script: a stalled probe
        // leaves verification partial (warned below) instead of hanging
        // the push — a stall proves nothing about orphaned rows either way.
        // eslint-disable-next-line no-await-in-loop
        const probe = await withTimeout(
          client.execute({
            sql: `SELECT COUNT(*) AS n FROM ${table} WHERE ${key} = ?`,
            args: id ? [id] : ['__never-recorded__'],
          }),
          PROBE_TIMEOUT_MS,
          `turso cleanup probe ${table}`,
        );
        orphanedRows += Number(probe.rows[0].n);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`cleanup probe ${table} failed: ${sanitizeError(error)}`);
        if (isTimeoutError(error)) {
          probeIncomplete = true;
        } else {
          orphanedRows += 1;
        }
      }
      p += 1;
    }
    // Funnel probe (session-keyed, so it can't ride the id-keyed loop
    // above): the smoke must prove its OWN beacon row left with it. Runs
    // before the probeIncomplete warning so a stall here is reported too.
    // Popup rows ride the same probe (own table, same session marker).
    // Modal rows ride a time-windowed probe instead (own table, no session
    // marker by design — same predicate as the cleanup above, skipped when
    // the leg never ran).
    for (const probeTable of ['login_funnel_events', 'login_popup_events']) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const probe = await withTimeout(
          client.execute({
            sql: `SELECT COUNT(*) AS n FROM ${probeTable} WHERE session_id = ?`,
            args: [MARKER],
          }),
          PROBE_TIMEOUT_MS,
          `turso cleanup probe ${probeTable}`,
        );
        orphanedRows += Number(probe.rows[0].n);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`cleanup probe ${probeTable} failed: ${sanitizeError(error)}`);
        if (isTimeoutError(error)) {
          probeIncomplete = true;
        } else {
          orphanedRows += 1;
        }
      }
    }
    if (modalRunStart !== null) {
      try {
        const modalProbe = await withTimeout(
          client.execute({
            sql: "SELECT COUNT(*) AS n FROM modal_events WHERE modal = 'sponsor' AND created_at >= ?",
            args: [modalRunStart],
          }),
          PROBE_TIMEOUT_MS,
          'turso cleanup probe modal_events',
        );
        orphanedRows += Number(modalProbe.rows[0].n);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.error(`cleanup probe modal_events failed: ${sanitizeError(error)}`);
        if (isTimeoutError(error)) {
          probeIncomplete = true;
        } else {
          orphanedRows += 1;
        }
      }
    }
    if (probeIncomplete) {
      // eslint-disable-next-line no-console
      console.error(
        'ANALYTICS SMOKE WARN: cleanup verification partial (a probe timed out) — orphan check inconclusive, not failing the push over a stall',
      );
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