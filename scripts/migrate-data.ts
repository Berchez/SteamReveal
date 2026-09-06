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
 *
 * The JSON source is discovered in this order:
 *   1. The newest snapshot under analytics-archive/<date>/analytics-data.json
 *      (the local-only PII archive taken when the proxy store was retired).
 *   2. The legacy path src/proxy-local/utils/analytics-data.json.
 * The .gitignore comment about re-importing from analytics-archive/ refers to
 * #1; the legacy path is kept as a fallback for machines that still have it.
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';

import type { SearchRecord } from '../src/lib/analytics/types';
import { buildStatements, type Statement } from './migrate-utils';

const LEGACY_JSON_PATH = path.resolve(
  process.cwd(),
  'src',
  'proxy-local',
  'utils',
  'analytics-data.json',
);

const findDataFile = (): string | null => {
  const archiveRoot = path.resolve(process.cwd(), 'analytics-archive');
  let newestFile: string | null = null;
  let newestMtime = -1;

  try {
    if (fs.existsSync(archiveRoot)) {
      // Snapshot before iterating (same pattern as src/lib/rateLimit.ts) to
      // appease airbnb's no-restricted-syntax (for...of is banned).
      Array.from(fs.readdirSync(archiveRoot, { withFileTypes: true })).forEach(
        (entry) => {
          if (!entry.isDirectory()) return;
          const candidate = path.join(archiveRoot, entry.name, 'analytics-data.json');
          if (fs.existsSync(candidate)) {
            const mtime = fs.statSync(candidate).mtimeMs;
            if (mtime > newestMtime) {
              newestFile = candidate;
              newestMtime = mtime;
            }
          }
        },
      );
    }
  } catch {
    // Unreadable archive dir — fall through to the legacy path.
  }

  if (newestFile) return newestFile;
  if (fs.existsSync(LEGACY_JSON_PATH)) return LEGACY_JSON_PATH;
  return null;
};

type ChunkResult = {
  /** Records in this chunk whose statements were assembled without a JS error. */
  assembled: number;
  /** Records skipped during statement assembly (reported individually). */
  skipped: number;
  /** True if db.batch() rejected the chunk (DB-level constraint failure). */
  batchFailed: boolean;
};

// Migrates one chunk of records. Isolation has two layers, both documented in
// the header comment of migrate-utils.buildStatements():
//   - Assembly errors (missing profile, unreadable shape) are caught per record
//     here, so one bad legacy record can't abort the migration.
//   - db.batch() is atomic, so a DB-level constraint failure (hand-imported
//     data with values the JS-level guards can't see) still rolls back the
//     whole chunk. That failure is caught here too: it's reported with the
//     chunk's record range and the migration carries on, instead of dying for
//     the rest of the dataset. The caller re-runs later once the data is fixed.
// Closing over no loop variables (all passed as args) keeps airbnb's
// no-loop-func happy — the chunk loop below stays index-driven.
const migrateChunk = async (
  db: ReturnType<typeof createClient>,
  chunk: SearchRecord[],
  startIndex: number,
): Promise<ChunkResult> => {
  const statements: Statement[] = [];
  let skipped = 0;

  chunk.forEach((record, j) => {
    try {
      statements.push(...buildStatements(record));
    } catch (err) {
      skipped += 1;
      // eslint-disable-next-line no-console
      console.error(
        `  SKIPPED record ${startIndex + j}${record?.id ? ` (id=${record.id})` : ''}: ${sanitizeError(err)}`,
      );
    }
  });

  const assembled = chunk.length - skipped;

  if (statements.length === 0) {
    return { assembled: 0, skipped, batchFailed: false };
  }

  try {
    await db.batch(statements);
    return { assembled, skipped, batchFailed: false };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      `  CHUNK [${startIndex}..${startIndex + chunk.length}) FAILED in db.batch (${assembled} record(s) not migrated): ${sanitizeError(err)}`,
    );
    return { assembled: 0, skipped, batchFailed: true };
  }
};

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

  const tokenError = requireRemoteTursoToken(url, process.env.DATABASE_TOKEN);
  if (tokenError) {
    // eslint-disable-next-line no-console
    console.error(tokenError);
    process.exit(1);
  }

  const jsonPath = findDataFile();
  if (!jsonPath) {
    // eslint-disable-next-line no-console
    console.error(
      `No analytics data found at analytics-archive/<date>/analytics-data.json or ${LEGACY_JSON_PATH} — nothing to migrate.`,
    );
    process.exit(0);
  }

  const raw = fs.readFileSync(jsonPath, 'utf-8');
  const records = JSON.parse(raw) as SearchRecord[];

  if (!Array.isArray(records) || records.length === 0) {
    // eslint-disable-next-line no-console
    console.log(`${path.basename(path.dirname(jsonPath))}/analytics-data.json is empty — nothing to migrate.`);
    process.exit(0);
  }

  // eslint-disable-next-line no-console
  console.log(`Found ${records.length} records in ${jsonPath}`);

  const db = createClient({
    url,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });

  let exitCode = 0;

  try {
    const BATCH_SIZE = 50;
    let migrated = 0;
    let combinedSkipped = 0;
    let chunkFailures = 0;

    let i = 0;
    while (i < records.length) {
      const chunk = records.slice(i, i + BATCH_SIZE);
      // Sequential on purpose: each chunk is one atomic batch, and running
      // them in parallel would let statement memory grow unbounded with the
      // dataset size while still being constrained by the same Turso rate
      // limits. Bounded, ordered progress beats throughput here.
      // eslint-disable-next-line no-await-in-loop
      const result = await migrateChunk(db, chunk, i);

      migrated += result.assembled;
      combinedSkipped += result.skipped;
      if (result.batchFailed) {
        chunkFailures += 1;
      }

      // eslint-disable-next-line no-console
      console.log(
        `  migrated ${migrated}/${records.length}${combinedSkipped ? `, skipped ${combinedSkipped}` : ''}${chunkFailures ? `, failed chunk(s) ${chunkFailures}` : ''}`,
      );
      i += BATCH_SIZE;
    }

    if (combinedSkipped > 0 || chunkFailures > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `\u26a0 ${combinedSkipped} record(s) were skipped and ${chunkFailures} chunk(s) failed (see messages above). Fix and re-run for a complete import — the migration is idempotent.`,
      );
      exitCode = 1;
    } else {
      // eslint-disable-next-line no-console
      console.log(`\u2714 Migrated ${migrated} records to Turso.`);
    }
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
  console.error('Unexpected error:', sanitizeError(err));
  process.exit(1);
});