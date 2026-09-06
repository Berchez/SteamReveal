import fs from 'fs';
import path from 'path';

/**
 * Minimal .env loader for standalone ts-node execution (the local proxy and
 * the CLI scripts run outside Next, so process.env isn't populated for us).
 *
 * Semantics match dotenv's default: an already-present env var is NEVER
 * overwritten, so vars injected by the host (CI, Vercel, shell exports) win.
 * Handles blank lines, full-line `#` comments, and surrounding quotes.
 */

export type EnvEntry = { key: string; value: string };

export const parseEnvFile = (content: string): EnvEntry[] => {
  const entries: EnvEntry[] = [];
  const lines = content.split(/\r?\n/);

  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }

    const idx = trimmed.indexOf('=');
    if (idx <= 0) {
      return;
    }

    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    entries.push({ key, value });
  });

  return entries;
};

export const loadEnv = (
  envPath: string = path.resolve(process.cwd(), '.env'),
): void => {
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf-8');

  parseEnvFile(content).forEach(({ key, value }) => {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
};

/**
 * Validates that a remote Turso URL carries a token. "Remote" means everything
 * except `file:` URLs (local SQLite needs no auth) — Turso serves the same
 * databases under both `libsql://` and `https://`, so both must be covered.
 *
 * Returns a human-readable error message when the config is invalid, null when
 * it is fine. Callers keep handling a missing DATABASE_URL themselves (the
 * error strings differ per tool), so a missing URL yields null here.
 */
export const requireRemoteTursoToken = (
  url: string | undefined,
  token: string | null | undefined,
): string | null => {
  if (!url) return null;
  if (url.startsWith('file:')) return null;
  return token
    ? null
    : 'DATABASE_TOKEN is required for remote Turso URLs (libsql:// or https://).';
};