#!/usr/bin/env node
/**
 * Applies the SQL migrations to the Turso (libSQL) analytics database.
 *
 * Migration files live in src/lib/analytics/migrations/ and must follow
 * the naming convention NNN_description.sql (e.g. 001_init.sql).
 *
 * Usage:
 *   pnpm run db:migrate
 *
 * Required env vars (read from .env if present, like the proxy):
 *   DATABASE_URL   e.g. libsql://steamreveal-xxx.turso.io
 *   DATABASE_TOKEN the Turso auth token (required for remote URLs)
 */
import fs from 'fs';
import path from 'path';
import { createClient } from '@libsql/client';
import { loadEnv } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';
import splitSqlStatements from '../src/lib/analytics/sqlStatements';

// Naming pattern: NNN_description.sql — reject stray files.
const MIGRATION_NAME_RE = /^\d{3}_.+\.sql$/;

function loadMigrationsDir(): string {
  return path.resolve(
    process.cwd(),
    'src',
    'lib',
    'analytics',
    'migrations',
  );
}

// Ensure a _migrations tracking table exists so that non-idempotent
// statements (e.g. ALTER TABLE ADD COLUMN) are only applied once.
async function ensureMigrationsTable(
  db: ReturnType<typeof createClient>,
): Promise<void> {
  await db.execute(
    'CREATE TABLE IF NOT EXISTS _migrations (filename TEXT PRIMARY KEY, applied_at TEXT NOT NULL)',
  );
}

async function main(): Promise<void> {
  loadEnv();

  const url = process.env.DATABASE_URL;
  if (!url) {
    // eslint-disable-next-line no-console
    console.error(
      'DATABASE_URL is missing from .env — set it to your Turso database URL (e.g. libsql://<db>-<org>.turso.io) and re-run.',
    );
    process.exit(1);
  }

  if (url.startsWith('libsql://') && !process.env.DATABASE_TOKEN) {
    // eslint-disable-next-line no-console
    console.error(
      'DATABASE_TOKEN is required for remote Turso URLs (libsql://). Set it in .env and re-run.',
    );
    process.exit(1);
  }

  const migrationsDir = loadMigrationsDir();

  if (!fs.existsSync(migrationsDir)) {
    // eslint-disable-next-line no-console
    console.error(
      `Migrations directory not found: ${migrationsDir}\nCreate it and add migration files (e.g. 001_init.sql) before running db:migrate.`,
    );
    process.exit(1);
  }

  const allFiles = fs.readdirSync(migrationsDir).sort();
  const migrationFiles = allFiles.filter((f) => MIGRATION_NAME_RE.test(f));
  const rejectedFiles = allFiles.filter(
    (f) => f.endsWith('.sql') && !MIGRATION_NAME_RE.test(f),
  );

  if (rejectedFiles.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `Warning: ignoring non-conforming migration files (expected NNN_name.sql): ${rejectedFiles.join(', ')}`,
    );
  }

  if (migrationFiles.length === 0) {
    // eslint-disable-next-line no-console
    console.error(`No conforming .sql migrations found in ${migrationsDir}`);
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.log(`Connecting to Turso database ...`);

  const db = createClient({
    url,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });

  let exitCode = 0;

  try {
    // Enforce foreign key constraints for the duration of this connection.
    // SQLite disables them by default; libSQL over HTTP may enforce them
    // server-side, but setting the pragma is the safe portable default.
    await db.execute('PRAGMA foreign_keys = ON');

    await ensureMigrationsTable(db);

    const alreadyApplied = await db.execute(
      'SELECT filename FROM _migrations ORDER BY filename',
    );
    const appliedSet = new Set(
      alreadyApplied.rows.map((r) => r.filename as string),
    );

    // Filter out already-applied migrations.
    const pending = migrationFiles.filter((f) => !appliedSet.has(f));

    if (pending.length === 0) {
      // eslint-disable-next-line no-console
      console.log('All migrations already applied — nothing to do.');
    }

    let i = 0;
    while (i < pending.length) {
      const file = pending[i];
      // eslint-disable-next-line no-console
      console.log(`Applying migration: ${file}`);
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');

      // batch() runs every statement in a single transaction, so the whole
      // migration file (its statements AND the _migrations bookkeeping row)
      // commits or rolls back as one unit. This matters once migrations are
      // non-idempotent (e.g. ALTER TABLE ADD COLUMN): a partial failure no
      // longer leaves the DDL applied but the file unrecorded.
      const statementArgs = splitSqlStatements(sql).map((statement) => ({
        sql: statement,
        args: [],
      }));

      const migrationInsert = {
        sql: 'INSERT INTO _migrations (filename, applied_at) VALUES (?, ?)',
        args: [file, new Date().toISOString()],
      };

      await db.batch([...statementArgs, migrationInsert]);

      // eslint-disable-next-line no-console
      console.log(`  → applied ${file}`);
      i += 1;
    }
  } catch (err) {
    // Sanitize error message — some drivers embed connection strings or tokens
    // in error objects, which would leak to CI/terminal logs.
    // eslint-disable-next-line no-console
    console.error('Migration failed:', sanitizeError(err));
    exitCode = 1;
  } finally {
    db.close();
  }

  if (exitCode !== 0) process.exit(exitCode);

  // eslint-disable-next-line no-console
  console.log('✔ All migrations applied.');
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Unexpected error:', err);
  process.exit(1);
});
