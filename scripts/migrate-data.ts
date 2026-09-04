#!/usr/bin/env node
/**
 * Migrates historical analytics records from analytics-data.json to Turso.
 *
 * Usage:
 *   pnpm run db:migrate-data
 *
 * Required env vars (read from .env):
 *   DATABASE_URL
 *   DATABASE_TOKEN
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { loadEnv } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import { toSqlBool, nullableText } from '../src/lib/analytics/sqlHelpers';

import type {
  SearchRecord,
} from '../src/proxy-local/utils/analytics';

function buildStatements(record: SearchRecord): Array<{ sql: string; args: (string | number | null)[] }> {
  const stmts: Array<{ sql: string; args: (string | number | null)[] }> = [];

  stmts.push({
    sql: 'INSERT OR IGNORE INTO searches (id, searched_at) VALUES (?, ?)',
    args: [record.id, record.searchedAt],
  });

  stmts.push({
    sql: `INSERT OR IGNORE INTO profiles
          (search_id, steam_id, steam_url, nickname, gc_name,
           country_code, state_code, city_id, is_cs_active, duration_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      record.id,
      record.profile.steamId,
      record.profile.steamUrl ?? null,
      record.profile.nickname ?? null,
      record.profile.gcName ?? null,
      record.profile.countryCode ?? null,
      record.profile.stateCode ?? null,
      nullableText(record.profile.cityId),
      toSqlBool(record.isCSActive),
      record.durationMs ?? null,
    ],
  });

  stmts.push({
    sql: `INSERT OR IGNORE INTO search_meta
          (search_id, requester_locale, requester_country,
           requester_browser_language, device)
          VALUES (?, ?, ?, ?, ?)`,
    args: [
      record.id,
      record.requesterLocale ?? null,
      record.requesterCountry ?? null,
      record.requesterBrowserLanguage ?? null,
      record.device ?? null,
    ],
  });

  // Child tables: DELETE existing rows for this search_id first, then INSERT.
  // This makes the migration idempotent — re-running after a partial failure
  // won't duplicate rows from already-migrated records.
  stmts.push({
    sql: 'DELETE FROM friends WHERE search_id = ?',
    args: [record.id],
  });
  record.friends.forEach((f) => {
    stmts.push({
      sql: `INSERT INTO friends
            (search_id, steam_id, nickname, gc_name,
             mutual_count, probability, country_code)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [
        record.id,
        f.steamId,
        f.nickname ?? null,
        f.gcName ?? null,
        f.mutualCount ?? null,
        f.probability ?? null,
        f.countryCode ?? null,
      ],
    });
  });

  stmts.push({
    sql: 'DELETE FROM games_snapshot WHERE search_id = ?',
    args: [record.id],
  });
  (record.gamesSnapshot ?? []).forEach((g) => {
    stmts.push({
      sql: 'INSERT INTO games_snapshot (search_id, name, playtime_hours) VALUES (?, ?, ?)',
      args: [record.id, g.name, g.playtimeHours],
    });
  });

  stmts.push({
    sql: 'DELETE FROM location_guesses WHERE search_id = ?',
    args: [record.id],
  });
  (record.locationGuess ?? []).forEach((lg) => {
    stmts.push({
      sql: 'INSERT INTO location_guesses (search_id, location, probability) VALUES (?, ?, ?)',
      args: [record.id, JSON.stringify(lg.location), lg.probability],
    });
  });

  if (record.cheater) {
    stmts.push({
      sql: `INSERT OR IGNORE INTO cheater_results
            (search_id, score, banned_friends_count, computed_at)
            VALUES (?, ?, ?, ?)`,
      args: [
        record.id,
        record.cheater.score,
        record.cheater.bannedFriendsCount ?? null,
        record.cheater.computedAt,
      ],
    });
  }

  return stmts;
}

async function main(): Promise<void> {
  loadEnv();

  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error(
      'DATABASE_URL is missing from .env — set it to your Turso database URL and re-run.',
    );
    process.exit(1);
  }

  if (url.startsWith('libsql://') && !process.env.DATABASE_TOKEN) {
    // eslint-disable-next-line no-console
    console.error(
      'DATABASE_TOKEN is required for remote Turso URLs. Set it in .env and re-run.',
    );
    process.exit(1);
  }

  const jsonPath = path.resolve(
    process.cwd(),
    'src',
    'proxy-local',
    'utils',
    'analytics-data.json',
  );

  if (!fs.existsSync(jsonPath)) {
    // eslint-disable-next-line no-console
    console.error(`No analytics data found at ${jsonPath} — nothing to migrate.`);
    process.exit(0);
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const records = JSON.parse(raw) as SearchRecord[];

  if (!Array.isArray(records) || records.length === 0) {
    // eslint-disable-next-line no-console
    console.log('analytics-data.json is empty — nothing to migrate.');
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`Found ${records.length} records in analytics-data.json`);

  const db = createClient({
    url,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });

  let exitCode = 0;

  try {
    const BATCH_SIZE = 50;
    let migrated = 0;

    let i = 0;
    while (i < records.length) {
      const chunk = records.slice(i, i + BATCH_SIZE);

      const allStatements = chunk.flatMap(buildStatements);
      await db.batch(allStatements);

      migrated += chunk.length;
      // eslint-disable-next-line no-console
      console.log(`  migrated ${migrated}/${records.length}`);
      i += BATCH_SIZE;
    }

    // eslint-disable-next-line no-console
    console.log(`✔ Migrated ${migrated} records to Turso.`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Migration failed:', sanitizeError(err));
    exitCode = 1;
  } finally {
    db.close();
  }

  if (exitCode !== 0) process.exit(exitCode);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error:', err);
  process.exit(1);
});
