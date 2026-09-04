const fs = require('fs');
const path = require('path');

const BASE = process.env.SMOKE_BASE || 'http://localhost:3001';
const TEST_STEAM_ID = '76561198000000000';
const htmlPath = path.join(__dirname, '..', 'src/proxy-local/utils/analytics.html');
const jsonPath = path.join(__dirname, '..', 'src/proxy-local/utils/analytics-data.json');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
  if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL not set — smoke requires Turso mode');
  process.exit(2);
}

const { createClient } = require('@libsql/client');
const client = createClient({ url: env.DATABASE_URL, authToken: env.DATABASE_TOKEN });

async function count() {
  const t = await client.execute('SELECT COUNT(*) AS n FROM searches');
  return Number(t.rows[0].n);
}

(async () => {
  let exitCode = 1;
  const before = await count();
  const jsonBefore = fs.readFileSync(jsonPath, 'utf8');
  const jsonCount = JSON.parse(jsonBefore).length;
  const htmlBak = `${htmlPath}.bak.${Date.now()}`;
  fs.copyFileSync(htmlPath, htmlBak);

  try {
    const rec = await fetch(`${BASE}/api/analytics/record`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile: { steamId: TEST_STEAM_ID }, friends: [] }),
    });
    if (!rec.ok) throw new Error(`record HTTP ${rec.status}`);
    const { id } = await rec.json();
    if (!id) throw new Error('record: missing id in response');

    const ch = await fetch(`${BASE}/api/analytics/cheater`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ searchId: id, score: 42 }),
    });
    if (!ch.ok) throw new Error(`cheater HTTP ${ch.status}`);

    const afterCount = await count();
    const landedInTurso = afterCount === before + 1;
    const jsonUntouched = jsonBefore === fs.readFileSync(jsonPath, 'utf8');

    await client.execute('DELETE FROM searches WHERE id = ?', [id]);
    const cleanCount = await count();

    const pass = landedInTurso && jsonUntouched && cleanCount === before;
    exitCode = pass ? 0 : 1;

    console.log(JSON.stringify({
      baseline: { turso: before, json: jsonCount },
      recordedId: id,
      afterWrite: { turso: afterCount },
      landedInTurso,
      jsonUntouched,
      afterDelete: cleanCount,
      PASS: pass,
    }, null, 2));
  } finally {
    fs.cpSync(htmlBak, htmlPath, { preserveTimestamps: true });
    fs.unlinkSync(htmlBak);
  }
  process.exit(exitCode);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});