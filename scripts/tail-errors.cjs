#!/usr/bin/env node
/**
 * Quick-check for trouble — `pnpm run logs:errors`.
 *
 * Prints the last N lines (default 50, `--lines=N` overridable) of the
 * combined `.data/logs/errors.log` written by the ops-log layer
 * (src/lib/opsLog.ts): every error from the site routes, the Watch Bot,
 * and the local proxy in one place, newest last.
 *
 * Plain Node, no dependencies (unlike the ts-node scripts, this one runs
 * with bare `node`, so it imports nothing from src/): resolves the log
 * dir like the writer does (OPS_LOG_DIR with || fallback, default
 * <repo>/.data/logs), including a minimal `.env.local`/`.env` lookup —
 * the bot/proxy load those via loadEnv(), so an OPS_LOG_DIR that lives
 * only there must resolve here too or writer and reader look in different
 * places. Approximately, not identically: run the writer and this script
 * from the repo root (per the runbook) and the two resolutions agree.
 *
 * Exit codes: 0 with output; 0 with a "no errors yet" / "directory not
 * found" notice when there is nothing to show (an empty error log is GOOD
 * news, and a missing directory means the writer may never have run here
 * or OPS_LOG_DIR points elsewhere — both get distinct messages because a
 * silent writer and a clean system look identical on disk); 1 on a REAL
 * I/O failure (only ENOENT maps to the notices — EACCES/EISDIR/EIO and
 * friends propagate to the outer catch); 2 on bad CLI usage.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_LINES = 50;

/**
 * Minimal .env lookup for OPS_LOG_DIR only: KEY=VALUE lines, first
 * occurrence wins, surrounding quotes stripped, relative paths resolved
 * against the repo root. Mirrors Next.js precedence: `.env.local` beats
 * `.env`; real environment always wins (never overridden). Only a subset
 * of dotenv semantics (no multiline values) — enough for a directory path.
 */
const readDotEnvOpsLogDir = () => {
  let envText;
  for (const name of ['.env.local', '.env']) {
    try {
      envText = fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
      break;
    } catch {
      envText = undefined;
    }
  }
  if (envText === undefined) return undefined;
  for (const rawLine of envText.split('\n')) {
    // Tolerate `export` prefixes and trailing inline comments (dotenv
    // semantics the writer enjoys via loadEnv); quoted values keep their
    // interior intact, unquoted ones end at ` #`.
    const match = /^\s*(?:export\s+)?OPS_LOG_DIR\s*=\s*(.*?)\s*$/.exec(rawLine);
    if (!match) continue;
    let value = match[1];
    const quoted = /^(['"])(.*)\1(\s+#.*)?$/.exec(value);
    if (quoted) {
      value = quoted[2];
    } else {
      const hashIndex = value.indexOf(' #');
      value = (hashIndex === -1 ? value : value.slice(0, hashIndex)).trim();
    }
    if (value === '') return undefined;
    return path.isAbsolute(value)
      ? value
      : path.join(__dirname, '..', value);
  }
  return undefined;
};

const resolveLogDir = () =>
  // || (not ??) on purpose — identical to the writer, so an empty string
  // falls back to the default on both sides instead of diverging.
  process.env.OPS_LOG_DIR ||
  readDotEnvOpsLogDir() ||
  path.join(__dirname, '..', '.data', 'logs');

const parseArgs = (argv) => {
  let lines = DEFAULT_LINES;
  for (const arg of argv) {
    // A lone separator forwarded by some pnpm versions is not an argument.
    if (arg === '--') continue;
    const match = /^--lines=(\d+)$/.exec(arg);
    if (!match) {
      console.error(
        `Unknown argument: ${arg}\nUsage: node scripts/tail-errors.cjs [--lines=N]`,
      );
      process.exit(2);
    }
    const parsed = Number.parseInt(match[1], 10);
    if (!Number.isInteger(parsed) || parsed < 1) {
      console.error(
        `Invalid --lines value: ${match[1]} (expected a positive integer)`,
      );
      process.exit(2);
    }
    lines = parsed;
  }
  return lines;
};

const main = () => {
  const lines = parseArgs(process.argv.slice(2));
  const logDir = resolveLogDir();
  const errorsPath = path.join(logDir, 'errors.log');

  let raw;
  try {
    raw = fs.readFileSync(errorsPath, 'utf8');
  } catch (error) {
    // Only a missing file means "nothing to show" — any other I/O failure
    // is real and propagates to the outer catch (exit 1).
    if (error && error.code !== 'ENOENT') throw error;
    let dirExists = false;
    try {
      dirExists = fs.statSync(logDir).isDirectory();
    } catch {
      dirExists = false;
    }
    if (!dirExists) {
      console.log(
        `Log directory not found: ${logDir} — the writer may never have run here, or OPS_LOG_DIR points elsewhere.`,
      );
    } else {
      console.log(`No errors logged yet (missing ${errorsPath}).`);
    }
    return;
  }

  const entries = raw.split('\n');
  if (entries.length > 0 && entries[entries.length - 1] === '') entries.pop();
  if (entries.length === 0) {
    console.log(`No errors logged yet (empty ${errorsPath}).`);
    return;
  }
  console.log(entries.slice(-lines).join('\n'));
};

try {
  main();
} catch (err) {
  console.error(
    `tail-errors failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
}
