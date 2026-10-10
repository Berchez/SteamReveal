#!/usr/bin/env node
/**
 * Owner-operated erasure helper: de-attribute ONE viewer's search history
 * (UPDATE searches SET searcher_steam_id = NULL WHERE searcher_steam_id
 * = ?). The searches themselves stay (dashboard aggregates and target
 * inboxes never show searcher identity) — only the who-searched-whom
 * link is cut, exactly like the in-app "Clear my history" (same DAL
 * call, DELETE /api/history, but operable without the user's session).
 *
 * Why this exists: an opted-out viewer with no live session cannot
 * reach "Clear my history" without re-adding the bot and logging in
 * again (documented self-serve path, see the runbook). Erasure requests
 * arriving through any other channel are served here instead of asking
 * the requester to re-friend. The 12-month TTL purge would do this
 * automatically anyway — this is the manual "right now".
 * (`delete-searches --steam-id` targets SEARCHED profiles, not
 * searchers — different predicate, different tool.)
 *
 * Dry-run by default (counts matches, updates nothing); `--confirm`
 * executes the UPDATE. The predicate is EXACTLY one 17-digit id
 * (--searcher-steam-id, required): unknown/valueless flags and stray
 * tokens reject (a typo must never widen an erasure), `--expect N`
 * aborts unless the count matches, and the post-UPDATE re-count must
 * read zero or the run FAILS loudly.
 *
 * Usage:
 *   ts-node -O "{\"module\": \"commonjs\"}\" scripts/delete-searcher-history.ts \
 *     --searcher-steam-id 76561198000000000 [--expect N] [--confirm]
 *
 * Required env (same as db:smoke): DATABASE_URL (+ DATABASE_TOKEN for
 * remote Turso URLs). Exits 1 on logic errors AND on transport failures
 * (manual destructive tool, never a gate — silence here would be worse
 * than noise).
 */
import { createClient } from '@libsql/client';
import { loadEnv, requireRemoteTursoToken } from '../src/lib/env';
import { sanitizeError } from '../src/lib/sanitizeError';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { withTimeout } = require('./smoke-timeout.cjs');

const HISTORY_TIMEOUT_MS = 25_000;

export interface DeleteSearcherHistoryFilters {
  searcherSteamId: string;
  expect: number | null;
}

const VALUE_FLAGS = new Set(['--searcher-steam-id', '--expect']);
const BOOLEAN_FLAGS = new Set(['--confirm']);

/**
 * Strict argv parsing (same discipline as delete-searches): the ONLY
 * accepted shape is --searcher-steam-id <17 digits> [--expect N]
 * [--confirm]. Anything else (unknown flags, valueless flags, stray
 * tokens, single-dash lookalikes, non-17-digit id, non-integer expect)
 * rejects (null) instead of risking a wider erasure.
 */
export const parseSearcherHistoryArgs = (
  argv: string[],
): DeleteSearcherHistoryFilters | null => {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      if (BOOLEAN_FLAGS.has(token)) continue;
      if (!VALUE_FLAGS.has(token)) return null;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) return null;
      values.set(token, next);
      i += 1;
      continue;
    }
    return null;
  }
  const searcherSteamId = values.get('--searcher-steam-id') ?? null;
  if (searcherSteamId === null || !/^\d{17}$/.test(searcherSteamId)) {
    return null;
  }
  const expectRaw = values.get('--expect') ?? null;
  const expect =
    expectRaw === null
      ? null
      : /^\d+$/.test(expectRaw)
        ? parseInt(expectRaw, 10)
        : null;
  if (expectRaw !== null && expect === null) return null;
  return { searcherSteamId, expect };
};

export const SEARCHER_HISTORY_COUNT_SQL =
  'SELECT COUNT(*) AS n FROM searches WHERE searcher_steam_id = ?';

export const SEARCHER_HISTORY_CLEAR_SQL =
  'UPDATE searches SET searcher_steam_id = NULL WHERE searcher_steam_id = ?';

const printUsageAndExit = (code: number): never => {
  // eslint-disable-next-line no-console
  console.error(
    'Usage: pnpm run db:delete-searcher-history -- --searcher-steam-id <17-digit-id> [--expect N] [--confirm]',
  );
  process.exit(code);
};

const isMain = (): boolean => {
  try {
    // ts-node CommonJS entrypoint check (same shape as the sibling scripts).
    return require.main === module;
  } catch {
    return false;
  }
};

if (isMain()) {
  const main = async (): Promise<void> => {
    const filters = parseSearcherHistoryArgs(process.argv.slice(2));
    if (filters === null) {
      printUsageAndExit(1);
      // Unreachable (usage printer exits) — keeps TS narrowing explicit
      // instead of relying on the never-return through the helper.
      process.exit(1);
    }

    loadEnv();
    if (!process.env.DATABASE_URL) {
      // eslint-disable-next-line no-console
      console.error('DELETE-SEARCHER-HISTORY FAIL: DATABASE_URL is not set.');
      process.exit(1);
    }
    const tokenError = requireRemoteTursoToken(
      process.env.DATABASE_URL,
      process.env.DATABASE_TOKEN,
    );
    if (tokenError) {
      // eslint-disable-next-line no-console
      console.error(`DELETE-SEARCHER-HISTORY FAIL: ${tokenError}`);
      process.exit(1);
    }

    const client = createClient({
      url: process.env.DATABASE_URL,
      authToken: process.env.DATABASE_TOKEN || undefined,
    });
    const confirm = process.argv.includes('--confirm');

    try {
      // eslint-disable-next-line no-console
      console.log(`Target searcher: ${filters.searcherSteamId}`);
      const counted = (await withTimeout(
        client.execute({
          sql: SEARCHER_HISTORY_COUNT_SQL,
          args: [filters.searcherSteamId],
        }),
        HISTORY_TIMEOUT_MS,
        'delete-searcher-history count',
      )) as { rows: Array<{ n: unknown }> };
      const totalMatches = Number(counted.rows[0]?.n ?? 0);
      // eslint-disable-next-line no-console
      console.log(
        `${totalMatches} linked searches for ${filters.searcherSteamId}.`,
      );
      if (filters.expect !== null && totalMatches !== filters.expect) {
        // eslint-disable-next-line no-console
        console.error(
          `DELETE-SEARCHER-HISTORY FAIL: expected ${filters.expect} matches, counted ${totalMatches} — refusing to erase a different set than reviewed.`,
        );
        client.close();
        process.exit(1);
      }
      if (!confirm) {
        // eslint-disable-next-line no-console
        console.log(
          'Dry-run: nothing erased. Re-run with --confirm to erase.',
        );
        client.close();
        process.exit(0);
      }
      if (totalMatches === 0) {
        client.close();
        process.exit(0);
      }
      await withTimeout(
        client.execute({
          sql: SEARCHER_HISTORY_CLEAR_SQL,
          args: [filters.searcherSteamId],
        }),
        HISTORY_TIMEOUT_MS,
        'delete-searcher-history clear',
      );
      const rechecked = (await withTimeout(
        client.execute({
          sql: SEARCHER_HISTORY_COUNT_SQL,
          args: [filters.searcherSteamId],
        }),
        HISTORY_TIMEOUT_MS,
        'delete-searcher-history recheck',
      )) as { rows: Array<{ n: unknown }> };
      const remaining = Number(rechecked.rows[0]?.n ?? -1);
      if (remaining !== 0) {
        // eslint-disable-next-line no-console
        console.error(
          `DELETE-SEARCHER-HISTORY FAIL: ${remaining} links remain after the clear — investigate, do not re-run blindly.`,
        );
        client.close();
        process.exit(1);
      }
      // eslint-disable-next-line no-console
      console.log(
        `Erased ${totalMatches} search-history links for ${filters.searcherSteamId} (searches kept for aggregates).`,
      );
      client.close();
      process.exit(0);
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error('DELETE-SEARCHER-HISTORY FAIL:', sanitizeError(error));
      client.close();
      process.exit(1);
    }
  };

  main().catch((error: unknown) => {
    // eslint-disable-next-line no-console
    console.error('DELETE-SEARCHER-HISTORY FAIL:', sanitizeError(error));
    process.exit(1);
  });
}
