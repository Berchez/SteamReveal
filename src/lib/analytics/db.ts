/**
 * Analytics DAL — Turso (libSQL) backend.
 *
 * Replaces the retired JSON-file store (recordSearch() and
 * attachCheaterProbability() used to live in the proxy's
 * utils/analytics.ts). Exported from src/lib/ so the Vercel serverless
 * routes consume it directly — no proxy forward anymore.
 *
 * Required env vars:
 *   DATABASE_URL   libsql://<db>-<org>.turso.io
 *   DATABASE_TOKEN Turso auth token
 */
import { createHash } from 'crypto';

import { createClient, type Client } from '@libsql/client';

import type {
  SearchRecord,
  CheaterProbabilityRecord,
  NewSearchInput,
  ProfileRecord,
  FriendRecord,
  FriendGcNameEntry,
  GameSnapshotEntry,
  LocationGuess,
  WatchAccount,
  WatchStatus,
  WatchEventKind,
  WatchEventStatus,
  WatchNotification,
  SearcherHistoryEntry,
  WatchedProfile,
  WatchEvent,
  WatchDashboardAccount,
  WatchDashboardWatched,
  WatchDashboardEvent,
  WatchDashboardData,
  DashboardCheaterRow,
  DashboardGameRow,
  DashboardLocationRow,
  DashboardStats,
  DashboardTopEntry,
  LoginFunnelEventKind,
  LoginFunnelStats,
  LoginPopupEventKind,
  LoginPopupStats,
  ModalDashboardStats,
  ModalEventKind,
  ModalKind,
  ModalStats,
  ExpiredConfirmCandidate,
  BanWatchSubscription,
  BanWatchTarget,
  BanAlertNotification,
  PopularProfile,
} from './types';
import { toSqlBool, nullableText } from './sqlHelpers';
import {
  HISTORY_PAGE_DEFAULT_LIMIT,
  HISTORY_PAGE_MAX_LIMIT,
  SEARCHER_LINK_TTL_MS,
} from './historyLimits';
import { isTransportFailure } from '../transientInfra';
import withTimeout from '../withTimeout';
import { normalizeFriendsVisibility } from './friendsVisibility';
import { normalizeCountryCode } from '../countryFlag';
import isWithinCooldownWindow from '../watch/cooldown';
import {
  WATCH_INBOX_DEFAULT_LIMIT,
  WATCH_INBOX_MAX_LIMIT,
} from '../watch/limits';
import { requireRemoteTursoToken } from '../env';
import { isSteamId64 } from '../steamId';
import {
  filterValidFriends,
  filterValidGames,
  filterValidLocations,
  MAX_FRIENDS,
  MAX_GAMES_SNAPSHOT,
  MAX_LOCATION_GUESSES,
} from './normalize';

// ---------------------------------------------------------------------------
// Client singleton (created once, reused across calls)
// ---------------------------------------------------------------------------

// The singleton is memoized as a Promise (not the resolved Client) so that
// concurrent cold-start calls share a single createClient() + PRAGMA setup
// instead of racing the `if (client) return client` check and building two
// connections (one of which would be orphaned). A failed creation resets the
// memo so the next call retries rather than caching the rejection forever.
let clientPromise: Promise<Client> | null = null;

const createClientInstance = async (): Promise<Client> => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is missing — set it in .env (e.g. libsql://<db>-<org>.turso.io)',
    );
  }

  const tokenError = requireRemoteTursoToken(url, process.env.DATABASE_TOKEN);
  if (tokenError) {
    throw new Error(tokenError);
  }

  const c = createClient({
    url,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });

  // SQLite disables FK enforcement by default; set it per-connection.
  // For HTTP transport (remote Turso), this applies to subsequent statements
  // on this client instance. Empirically verified against a real Turso remote
  // DB: the pragma persists across separate execute() calls on the same client
  // session, and ON DELETE CASCADE fires over HTTP.
  await c.execute('PRAGMA foreign_keys = ON');

  return c;
};

const getClient = (): Promise<Client> => {
  if (clientPromise) return clientPromise;

  clientPromise = createClientInstance().catch((error) => {
    clientPromise = null;
    throw error;
  });

  return clientPromise;
};

// ---------------------------------------------------------------------------
// Schema-missing detection. A fresh Turso DB has no tables until `pnpm run
// db:migrate` runs; a missing-schema failure currently surfaces as a generic
// 500 ("INTERNAL_ERROR") downstream. Rewrite only that specific case into a
// message that points at the fix, leaving every other error untouched.
// ---------------------------------------------------------------------------

const SCHEMA_MISSING_PATTERN = /no such (table|column)|has no column named/i;

/**
 * True when a DB error means "searches.searcher_steam_id does not
 * exist yet" (020 pending). Shared by the recordSearch fallback (and,
 * historically, removeWatchAndAccount's — that one is gone: opt-out
 * no longer touches the column) so the predicate can never drift
 * between call sites: the error must BOTH look schema-missing (the
 * narrow arm above, not any error that happens to name the column —
 * e.g. a typo'd SELECT elsewhere would otherwise trigger a wrong
 * fallback) AND name this exact column. withSchemaHint rewrites the
 * message first but appends the original, so matching still works
 * downstream of it.
 *
 * TODO(020-cleanup): once 020 has run in every environment (prod Turso
 * included — NOT just local) AND one release has passed with zero
 * fallback warns in the logs, delete this helper, the recordSearch
 * fallback, and the warn-once logger, and let the column be
 * unconditional. Until then the deploy/migrate window needs the
 * bridge. Grep isSearcherColumnMissing to find every piece.
 */
export const isSearcherColumnMissing = (error: unknown): boolean =>
  error instanceof Error &&
  SCHEMA_MISSING_PATTERN.test(error.message) &&
  /searcher_steam_id/i.test(error.message);

// A client that was created fine can still die later (idle timeout, network
// blip, Turso closing a hrana session). The predicate lives in one place —
// src/lib/transientInfra.ts (pure, no DAL import) — so the bot pollers and
// the pre-push smoke gates share the vocabulary. This memo-drop
// deliberately uses the NARROW predicate (dead connection only): on a
// Turso-backend 5xx/S3 the connection is healthy and only the backend is
// sick, so dropping the client would add reconnect churn (plus an unclosed
// socket) on top of every failure during an outage. Re-exported below so
// existing importers keep compiling with unchanged (narrow) semantics.
export { isTransportFailure };

const withSchemaHint = async <T>(operation: Promise<T>): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof Error &&
      SCHEMA_MISSING_PATTERN.test(error.message)
    ) {
      // Keep the original message appended: the hint covers the real
      // pending-migration case (missing table/column), but a genuine
      // query bug (typo'd column) matches the same pattern — swallowing
      // the original text would send that debug session hunting a
      // migration that already ran.
      throw new Error(
        `Analytics database schema is missing — run \`pnpm run db:migrate\` first. (Original DB error: ${error.message})`,
      );
    }
    // If a transport failure is caught here, the memoized client is stale —
    // null it so the next call reconnects. Deliberately WITHOUT closing the
    // discarded client: withSchemaHint only sees the failed operation, never
    // which client it ran on, so a close could land on a freshly recreated
    // healthy client that concurrent ops are using (close kills their
    // in-flight queries, which then reset again — a cascade during exactly
    // the outage the reset is meant to absorb). The discarded client is
    // always a dead connection (narrow predicate above), whose socket
    // errors out and frees itself; the pre-existing null-only behavior
    // never produced a leak incident. All operations on the memo share
    // this catch, so a failure handled after a concurrent call already
    // re-created the memo can null a fresh healthy client too: worst case is
    // ONE wasted reconnect on the next call (self-healing, no data impact).
    if (isTransportFailure(error) && clientPromise !== null) {
      clientPromise = null;
    }
    throw error;
  }
};

// ---------------------------------------------------------------------------
// Test-only helpers: let integration tests drive the memoized client that the
// DAL actually uses, so a `file::memory:` DATABASE_URL can host both the
// migration and the queries on a single connection (no temp files, no Windows
// lock-release races). Nothing in production calls these.
// ---------------------------------------------------------------------------

export const closeClientForTests = async (): Promise<void> => {
  if (clientPromise) {
    const client = await clientPromise;
    client.close();
    clientPromise = null;
  }
};

export const executeForTests = async (
  sql: string,
  args?: (string | number | null)[],
): Promise<Awaited<ReturnType<Client['execute']>>> => {
  const db = await getClient();
  return withSchemaHint(args ? db.execute({ sql, args }) : db.execute(sql));
};

// Warn-once flag for the 020-pending recordSearch fallback below:
// every call during the window would otherwise log an identical line.
// Placed above its caller (no-use-before-define).
let missingSearcherColumnWarned = false;

const logMissingSearcherColumnOnce = (caller: string): void => {
  if (missingSearcherColumnWarned) return;
  missingSearcherColumnWarned = true;
  // eslint-disable-next-line no-console
  console.warn(
    `${caller}: searches.searcher_steam_id is missing — degrading without it until \`pnpm run db:migrate\` applies 020.`,
  );
};

/** Test-only seam: re-arm the warn-once above between tests. */
export const resetMissingSearcherColumnWarnForTests = (): void => {
  missingSearcherColumnWarned = false;
};

// Short-lived "column is missing" memory (deploy/migrate window only):
// without it EVERY recordSearch during the window pays a doomed first
// batch (up to ~2013 statements) before the fallback. While set, new
// calls go column-less directly. 60s TTL: if the migration lands
// mid-window, at most a minute of anonymous writes follow (self-heals;
// the read path treats NULL as anonymous either way). Expired cache =
// normal attempt again (which re-arms on failure).
let searcherColumnMissingUntilMs = 0;
const SEARCHER_COLUMN_MISS_TTL_MS = 60_000;

const isSearcherColumnMissingCached = (): boolean =>
  Date.now() < searcherColumnMissingUntilMs;

const cacheSearcherColumnMissing = (caller: string): void => {
  logMissingSearcherColumnOnce(caller);
  searcherColumnMissingUntilMs = Date.now() + SEARCHER_COLUMN_MISS_TTL_MS;
};

/** Test-only seam: drop the miss cache between tests. */
export const resetSearcherColumnMissingCacheForTests = (): void => {
  searcherColumnMissingUntilMs = 0;
};

// ---------------------------------------------------------------------------
// recordSearch — insert a completed search across all normalized tables.
// Uses db.batch() so the entire insert is atomic (BEGIN/COMMIT/ROLLBACK).
//
// Statements in one batch are bounded by the shared caps (normalize.ts
// MAX_FRIENDS=1000, MAX_GAMES_SNAPSHOT=1000, MAX_LOCATION_GUESSES=10) — re-
// applied here on top of the route parser's own slice — plus the 3 parent
// rows: at most ~2013 statements in a single batch. That's the largest
// transaction this code ever opens — well inside @libsql/client's practical
// batch sizes, but the number matters if the transport ever changes.
// ---------------------------------------------------------------------------

export const recordSearch = async (
  input: NewSearchInput,
): Promise<SearchRecord> => {
  const db = await getClient();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const searchedAt = new Date().toISOString();

  // Normalized ONCE so the returned record and the stored row always
  // agree on SHAPE (malformed degrades to null, never stored corrupt):
  // whether the id actually STICKS is decided atomically by the INSERT
  // below (footprint subquery), so a footprintless session returns its
  // id here but stores NULL — optimistic by one row, and harmless: the
  // only consumer of the returned record (the route) reads record.id,
  // and the read path treats NULL as anonymous either way.
  const searcherSteamId =
    typeof input.searcherSteamId === 'string' &&
    isSteamId64(input.searcherSteamId)
      ? input.searcherSteamId
      : null;

  const record: SearchRecord = {
    id,
    searchedAt,
    cheater: null,
    ...input,
    searcherSteamId,
  };

  // Built by closures (not inline) because the 020-pending fallback
  // below swaps exactly the searches statement: identity by reference
  // keeps the swap from depending on array position.
  //
  // Attribution is a footprint SUBQUERY on the searches row itself, not
  // a value: (SELECT steam_id FROM accounts WHERE steam_id = ?)
  // resolves to the id when a live ACCOUNT row exists and to NULL
  // otherwise — inside the SAME atomic batch as the insert. Accounts
  // (not watched_profiles) is the anchor on purpose: a bot-swap wipes
  // and rebuilds watches, but accounts persist, so attribution resumes
  // by itself after a swap; a genuine opt-out deletes the account row,
  // which stops NEW attribution on the spot and hides the old rows via
  // the read-side footprint gate — while the OLD links persist by
  // product decision (only the explicit Clear and the 12-month TTL
  // purge ever cut them). That kills two birds the old check-then-write
  // had: no TOCTOU window between a footprint read and the write (an
  // opt-out landing mid-batch loses the race to the transaction, never
  // re-links), and no extra PK round-trip on the search write path.
  // Guests pass NULL (subquery over NULL matches nothing — one
  // statement shape for both lanes).
  const searchesStatement = (withSearcher: boolean) => ({
    // 1. Root entity (+ attribution)
    sql: withSearcher
      ? `INSERT INTO searches (id, searched_at, searcher_steam_id)
            VALUES (?, ?,
              (SELECT steam_id FROM accounts WHERE steam_id = ?))`
      : `INSERT INTO searches (id, searched_at) VALUES (?, ?)`,
    args: withSearcher ? [id, searchedAt, searcherSteamId] : [id, searchedAt],
  });
  const searchMetaStatement = () => ({
    // 3. Search meta (1:1) — no searcher column: who-ran-the-search
    // lives on searches (020), indexed for the history read.
    sql: `INSERT INTO search_meta
            (search_id, requester_locale, requester_country,
              requester_browser_language, device, friends_visibility)
            VALUES (?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      record.requesterLocale ?? null,
      // Normalized at write (same choke point as every read): 'br'
      // and 'BR' must never become two buckets/flags downstream.
      // Direct DAL callers get the same guarantee as the HTTP parser.
      normalizeCountryCode(record.requesterCountry),
      record.requesterBrowserLanguage ?? null,
      record.device ?? null,
      normalizeFriendsVisibility(record.friendsVisibility),
    ] as (string | number | null)[],
  });
  // Miss-cache fast path (see above): while the 020 miss is cached,
  // skip the doomed first batch and go column-less directly — same
  // anonymous result as the fallback below, at half the write cost.
  // Guests skip the column unconditionally (searcherSteamId null can
  // never stick): their writes must not depend on migration/deploy
  // order at all.
  const rootStatement = searchesStatement(
    searcherSteamId !== null && !isSearcherColumnMissingCached(),
  );
  const metaStatement = searchMetaStatement();

  const statements: Array<{ sql: string; args: (string | number | null)[] }> = [
    // 1. Root entity
    rootStatement,
    // 2. Profile (1:1)
    {
      sql: `INSERT INTO profiles
            (search_id, steam_id, steam_url, nickname, gc_name,
              country_code, state_code, city_id, is_cs_active, duration_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
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
    },
    metaStatement,
  ];

  // 4. Friends (N:1) — the route parser already validated/trimmed these, but
  // recordSearch is callable by anyone; the shared filters + caps are cheap
  // defense in depth (same MAX_* the parser applies, so a batch can never
  // exceed ~2013 statements).
  filterValidFriends(record.friends)
    .slice(0, MAX_FRIENDS)
    .forEach((f) => {
      statements.push({
        sql: `INSERT INTO friends
            (search_id, steam_id, nickname, gc_name,
             mutual_count, probability, country_code)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
        args: [
          id,
          f.steamId,
          f.nickname ?? null,
          f.gcName ?? null,
          f.mutualCount ?? null,
          f.probability ?? null,
          f.countryCode ?? null,
        ],
      });
    });

  // 5. Games snapshot (N:1)
  filterValidGames(record.gamesSnapshot ?? [])
    .slice(0, MAX_GAMES_SNAPSHOT)
    .forEach((g) => {
      statements.push({
        sql: 'INSERT INTO games_snapshot (search_id, name, playtime_hours) VALUES (?, ?, ?)',
        args: [id, g.name, g.playtimeHours],
      });
    });

  // 6. Location guesses (N:1) — location is a JSON-serialized object
  filterValidLocations(record.locationGuess ?? [])
    .slice(0, MAX_LOCATION_GUESSES)
    .forEach((lg) => {
      statements.push({
        sql: 'INSERT INTO location_guesses (search_id, location, probability) VALUES (?, ?, ?)',
        args: [id, JSON.stringify(lg.location), lg.probability],
      });
    });

  try {
    await withSchemaHint(db.batch(statements));
  } catch (error) {
    // 020-pending fallback: when the column does not exist yet, retry the
    // same atomic batch WITHOUT the searcher (anonymous) instead of
    // failing the search — and with it, the Watch notify hook that runs
    // after recordSearch in the route. Migration-first deploy remains the
    // contract (this path also warns loudly once per process, so a stuck
    // migration stays visible instead of rotting silently); the fallback
    // only bridges the deploy/migrate window. Any OTHER error rethrows.
    if (!isSearcherColumnMissing(error)) {
      throw error;
    }
    cacheSearcherColumnMissing('recordSearch');
    statements[statements.indexOf(rootStatement)] =
      searchesStatement(false);
    await withSchemaHint(db.batch(statements));
    return { ...record, searcherSteamId: null };
  }

  // Cache-hit path returns anonymous too (the column was missing when
  // cached — nothing was stored under this searcher).
  if (isSearcherColumnMissingCached()) {
    return { ...record, searcherSteamId: null };
  }

  return record;
};

// ---------------------------------------------------------------------------
// attachCheaterProbability — upsert the cheater result for an existing search.
// Returns false if the searchId doesn't exist in searches.
// ---------------------------------------------------------------------------

export const attachCheaterProbability = async (
  searchId: string,
  cheater: CheaterProbabilityRecord,
): Promise<boolean> => {
  const db = await getClient();

  // Explicit pre-check instead of parsing an FK-violation message. Has a tiny
  // non-atomic window vs. a hypothetical concurrent search deletion — harmless
  // today, since nothing in the app deletes searches (would throw, not corrupt).
  const exists = await withSchemaHint(
    db.execute({
      sql: 'SELECT 1 FROM searches WHERE id = ?',
      args: [searchId],
    }),
  );

  if (exists.rows.length === 0) return false;

  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO cheater_results
            (search_id, score, banned_friends_count, computed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(search_id) DO UPDATE SET
              score = excluded.score,
              banned_friends_count = excluded.banned_friends_count,
              computed_at = excluded.computed_at`,
      args: [
        searchId,
        cheater.score,
        cheater.bannedFriendsCount ?? null,
        cheater.computedAt,
      ],
    }),
  );

  return true;
};

// ---------------------------------------------------------------------------
// attachFriendGcNames — fill friends.gc_name for an existing search with names
// the client resolved AFTER the initial recordSearch (the friend cards fetch
// each GC name post-render, so the original payload carries nulls).
//
// Best-effort, non-atomic by design: this is an informational enrichment —
// losing one UPDATE to a concurrent write costs nothing. Returns the number
// of rows actually updated, plus whether the search existed, so the route can
// distinguish "no such search" (404) from "search exists but zero friends
// matched" (200 with updated: 0).
// ---------------------------------------------------------------------------

export type AttachFriendGcNamesResult = {
  searchExists: boolean;
  updated: number;
};

const toRowsUpdated = (
  results: Awaited<ReturnType<Client['batch']>> | undefined,
): number => {
  if (!results) return 0;
  return results.reduce(
    (sum, result) => sum + (Number(result?.rowsAffected) || 0),
    0,
  );
};

export const attachFriendGcNames = async (
  searchId: string,
  entries: FriendGcNameEntry[],
): Promise<AttachFriendGcNamesResult> => {
  const db = await getClient();

  // Explicit pre-check instead of parsing an FK-violation message (same
  // pattern as attachCheaterProbability). A missing search is a client error
  // the route surfaces as 404, not a fatal one.
  const exists = await withSchemaHint(
    db.execute({
      sql: 'SELECT 1 FROM searches WHERE id = ?',
      args: [searchId],
    }),
  );
  if (exists.rows.length === 0) {
    return { searchExists: false, updated: 0 };
  }

  // Defense in depth: never write a blank name, and only touch Steam64 ids.
  // The route parser already enforced both; recordSearch's own callers are
  // the same DACL as here, but the DAL stays self-protective like every
  // other entry point.
  const valid = entries.filter(
    (entry) =>
      entry != null &&
      isSteamId64(entry.steamId) &&
      typeof entry.gcName === 'string' &&
      entry.gcName.trim().length > 0 &&
      entry.gcName.length <= 2000,
  );
  if (valid.length === 0) {
    return { searchExists: true, updated: 0 };
  }

  const results = await withSchemaHint(
    db.batch(
      valid.map((entry) => ({
        sql: 'UPDATE friends SET gc_name = ? WHERE search_id = ? AND steam_id = ?',
        args: [entry.gcName, searchId, entry.steamId],
      })),
    ),
  );

  return { searchExists: true, updated: toRowsUpdated(results) };
};

// ---------------------------------------------------------------------------
// Watch Bot — watched_profiles + watch_events outbox (Epic 1, migration
// 002_watch_bot.sql).
//
// Ownership split (later Epics consume this, none of it lives here):
// - Epic 2/3 (bot + linking): createWatchRequest / activateWatch /
//   claimNextQueuedEvents(kind='invite') / markEventSent.
// - Epic 4 (notify hook): getWatchStatus + isWithinCooldown gate the enqueue;
//   enqueueEvent(kind='notify') -> claimNextQueuedEvents(kind='notify') ->
//   markEventSent/markEventDropped.
// - Epic 5/6 (inbox + opt-out): the inbox reads RECORDED SEARCHES
//   (listProfileSearches — every view, no cooldown gate), NOT watch_events
//   (the bot's delivery log stays bot-side); deactivateWatch is the opt-out.
//
// Two deliberate deviations from the ticket text, both documented:
// 1. A transient 'claimed' status exists alongside queued/sent/dropped.
//    "Claim without duplicating under concurrency" is impossible with
//    read-then-mark (two pollers can read the same rows); the claim is a
//    single atomic UPDATE...RETURNING, which needs a marker state. Rows
//    never rest in 'claimed' — resetStaleClaims requeues orphans left by a
//    crashed worker.
// 2. enqueueEvent does NOT check watch status. Policy ("only notify
//    active watches") belongs to the Epic 4 hook, which has the cooldown
//    context; this layer stays a dumb, single-purpose outbox.
// ---------------------------------------------------------------------------

// Single source of truth lives in src/lib/steamId.ts (never fork the
// regex per call site): this assert keeps the DAL's throw contract
// (message pinned by tests) on top of the shared shape check.
const assertSteamId64 = (steamId: string): void => {
  if (!isSteamId64(steamId)) {
    throw new Error('Invalid SteamID64 for watch DAL: expected 17 digits');
  }
};

// NOTE: this validates HASHES (SHA-256 hex), never raw tokens — it just
// happens that our raw tokens are also 64 hex chars (32 random bytes),
// so the same shape matches both. Keep it that way: if token generation
// ever changes length/encoding, this assert must stay hash-shaped and
// the route's shape-gate (confirm/route.ts) token-shaped, independently.
const TOKEN_HASH_RE = /^[0-9a-f]{64}$/;

const assertTokenHash = (tokenHash: string, kind: string): void => {
  if (typeof tokenHash !== 'string' || !TOKEN_HASH_RE.test(tokenHash)) {
    throw new Error(
      `Invalid ${kind}: expected 64 lowercase hex chars`,
    );
  }
};

const assertConfirmTokenHash = (tokenHash: string): void => {
  assertTokenHash(tokenHash, 'confirm token hash for watch DAL');
};

const assertWatchEventKind: (kind: string) => asserts kind is WatchEventKind = (
  kind,
) => {
  if (
    kind !== 'invite' &&
    kind !== 'notify' &&
    kind !== 'welcome' &&
    kind !== 'confirm_resend' &&
    kind !== 'ban_alert'
  ) {
    throw new Error(
      "Invalid watch event kind: expected 'invite' | 'notify' | 'welcome' | 'confirm_resend' | 'ban_alert'",
    );
  }
};

const assertOptionalWatchStatus: (
  status: string | undefined,
) => asserts status is WatchStatus | undefined = (status) => {
  if (status !== undefined && status !== 'pending' && status !== 'active') {
    throw new Error(
      "Invalid watch status filter: expected 'pending' | 'active'",
    );
  }
};

/**
 * Matches SQLite/Turso unique-violation errors (PK + UNIQUE constraints).
 * Verified against @libsql/client 0.18.0: mapHranaError passes the server
 * message through unmodified into LibsqlError, so the SQLite-canonical
 * "UNIQUE constraint failed: ..." text survives the hrana transport
 * verbatim (same reason withSchemaHint's message matching works remotely).
 */
const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

// Locale is informational (bot message language), never load-bearing: an
// absent or malformed locale coerces to null instead of failing the watch.
const normalizeLocale = (locale: string | null | undefined): string | null => {
  if (typeof locale !== 'string') return null;
  const trimmed = locale.trim().slice(0, 10);
  if (!/^[A-Za-z]{2,5}(-[A-Za-z]{2,5})?$/.test(trimmed)) return null;
  return trimmed;
};

const toWatchedProfile = (row: Record<string, unknown>): WatchedProfile => ({
  steamId: row.steam_id as string,
  // Writes only ever store 'pending' | 'active'; anything else read back
  // (hand-edited rows) collapses to 'pending' rather than leaking an
  // unknown status into callers typed as WatchStatus.
  status: row.status === 'active' ? 'active' : 'pending',
  locale: typeof row.locale === 'string' ? row.locale : null,
  requestedAt: row.requested_at as string,
  activatedAt: typeof row.activated_at === 'string' ? row.activated_at : null,
  lastNotifiedAt:
    typeof row.last_notified_at === 'string' ? row.last_notified_at : null,
});

const toWatchEventKind = (value: unknown): WatchEventKind => {
  // Writes only ever store the five lane names; anything else read back
  // (hand-edited rows) collapses to 'invite' rather than leaking an
  // unknown kind into pollers typed as WatchEventKind.
  if (
    value === 'notify' ||
    value === 'welcome' ||
    value === 'confirm_resend' ||
    value === 'ban_alert'
  ) {
    return value;
  }
  return 'invite';
};

const toWatchEvent = (row: Record<string, unknown>): WatchEvent => ({
  id: Number(row.id),
  searchId: typeof row.search_id === 'string' ? row.search_id : null,
  steamId: row.steam_id as string,
  kind: toWatchEventKind(row.kind),
  status:
    row.status === 'claimed' ||
    row.status === 'sent' ||
    row.status === 'dropped'
      ? row.status
      : 'queued',
  createdAt: row.created_at as string,
  claimedAt: typeof row.claimed_at === 'string' ? row.claimed_at : null,
  sentAt: typeof row.sent_at === 'string' ? row.sent_at : null,
});

/**
 * Creates a pending watch request. Idempotent: at most one row per
 * SteamID64 — an existing row (pending AND active alike) is returned
 * untouched instead of inserting a duplicate. Implemented as a single
 * INSERT ... ON CONFLICT DO NOTHING + SELECT, so two concurrent requests
 * for the same profile cannot create two rows (no read-then-write race).
 *
 * PAIRING INVARIANT (do not break): every production creation path must
 * create the `accounts` row alongside (signup does, unconditionally —
 * locked by signup/route.test.ts asserting the createAccount call). The
 * activateWatch legacy carve-out activates account-less rows WITHOUT a
 * click, so a future caller creating watches without accounts would
 * silently reopen the exact bug the click-to-activate gate closed.
 */
export const createWatchRequest = async (
  steamId: string,
  locale?: string | null,
): Promise<WatchedProfile> => {
  assertSteamId64(steamId);
  const db = await getClient();
  const now = new Date().toISOString();

  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO watched_profiles
            (steam_id, status, locale, requested_at, activated_at, last_notified_at)
            VALUES (?, 'pending', ?, ?, NULL, NULL)
            ON CONFLICT(steam_id) DO NOTHING`,
      args: [steamId, normalizeLocale(locale), now],
    }),
  );

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
            FROM watched_profiles WHERE steam_id = ?`,
      args: [steamId],
    }),
  );

  // Unreachable unless the row was deleted between the two statements above
  // (nothing in the app deletes watches except deactivateWatch, which no
  // concurrent path calls mid-create). Throw rather than fabricate a row.
  if (row.rows.length === 0) {
    throw new Error('createWatchRequest lost a concurrent race unexpectedly');
  }

  return toWatchedProfile(row.rows[0] as Record<string, unknown>);
};

export interface EnsureActiveWatchResult {
  profile: WatchedProfile;
  /**
   * True when THIS call newly activated the row (fresh insert, or a legacy
   * pending flip) — the only case the caller enqueues a welcome for.
   * False when the row was already active (idempotent re-login).
   */
  activated: boolean;
}

/**
 * Single-state-model watch ensure: fresh profiles insert directly as
 * active (friendship was just proven at login — there is no pending step
 * on the fresh lane), already-active rows are untouched, and pending rows
 * flip ONLY when the click-to-activate gate would also let them through:
 * no `accounts` row at all (grandfathered pre-confirmation consent) or an
 * already-confirmed account. A pending row with an UNCONFIRMED account
 * (the confirm-link lane: Start → invite → link not yet clicked) is LEFT
 * pending — the link click (confirm route POST) stays its sole activator,
 * so a re-login can never bypass the click the user still owes.
 *
 * That predicate mirrors `activateWatch` on purpose: login proves account
 * ownership, but the pending row proves the user chose the link lane, and
 * flipping it here would reopen the exact "friendship alone activates"
 * bug §12 of the confirm plan closed. Callers seal the session either way
 * (login succeeds; only the watch state differs), and `activated=false`
 * tells them no welcome is owed.
 *
 * Race-safe by construction: the insert is ON CONFLICT DO NOTHING (one
 * winner), and the flip carries the confirmation gate in its own WHERE
 * (same predicate as activateWatch — a concurrent signup arming an
 * unconfirmed account between the fast-path read and the write cannot
 * flip). A 0-row flip re-reads the true current row (concurrent
 * activation OR gate-blocked pending). Exactly one concurrent caller
 * observes activated=true, so welcome emission never duplicates. A
 * click landing between the account read and the flip converges
 * harmlessly: the click's own activate owns the flip + welcome, this
 * call re-reads active with activated=false.
 */

/**
 * Shared click-to-activate gate predicate (SQL fragment, not a helper):
 * a pending watch flips only with no `accounts` row at all (grandfathered
 * pre-confirmation consent) or an already-confirmed account. Both
 * `activateWatch` and `ensureActiveWatch` inline it so each stays a single
 * atomic UPDATE while the predicate text exists exactly once — edit here
 * and both gates move together (the equivalence test below pins that).
 * Takes the steam_id TWICE (? , ?): each call site appends its own two
 * steamId args right after its other placeholders, in this order.
 */
const ACTIVATION_GATE_SQL = `AND (
  NOT EXISTS (SELECT 1 FROM accounts WHERE steam_id = ?)
  OR EXISTS (
    SELECT 1 FROM accounts
    WHERE steam_id = ? AND confirmed_at IS NOT NULL
  )
)`;

export const ensureActiveWatch = async (
  steamId: string,
  locale?: string | null,
): Promise<EnsureActiveWatchResult> => {
  assertSteamId64(steamId);
  const db = await getClient();
  const now = new Date().toISOString();

  const inserted = await withSchemaHint(
    db.execute({
      sql: `INSERT INTO watched_profiles
            (steam_id, status, locale, requested_at, activated_at, last_notified_at)
            VALUES (?, 'active', ?, ?, ?, NULL)
            ON CONFLICT(steam_id) DO NOTHING`,
      args: [steamId, normalizeLocale(locale), now, now],
    }),
  );
  if (Number(inserted.rowsAffected) > 0) {
    return {
      profile: {
        steamId,
        status: 'active',
        locale: normalizeLocale(locale),
        requestedAt: now,
        activatedAt: now,
        lastNotifiedAt: null,
      },
      activated: true,
    };
  }

  const existing = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
            FROM watched_profiles WHERE steam_id = ?`,
      args: [steamId],
    }),
  );
  if (existing.rows.length === 0) {
    throw new Error('ensureActiveWatch lost a concurrent race unexpectedly');
  }
  const current = toWatchedProfile(existing.rows[0] as Record<string, unknown>);
  if (current.status === 'active') {
    // Idempotent re-login: the watch stays active (activated=false so no
    // welcome re-fires) but the locale refreshes — the login just proved
    // the user's current language, and bot messages follow it.
    const refreshed = await withSchemaHint(
      db.execute({
        sql: `UPDATE watched_profiles
              SET locale = COALESCE(?, locale)
              WHERE steam_id = ? AND status = 'active'`,
        args: [normalizeLocale(locale), steamId],
      }),
    );
    if (Number(refreshed.rowsAffected) > 0) {
      return {
        profile: {
          ...current,
          locale: normalizeLocale(locale) ?? current.locale,
        },
        activated: false,
      };
    }
    return { profile: current, activated: false };
  }

  // Confirm-lane check (click-to-activate preservation): a pending row
  // WITH an unconfirmed account stays pending — its link click is still
  // outstanding and this login must not spend it. Inline SELECT (not the
  // getAccount helper below — this function is defined first and the repo
  // lints no-use-before-define): same predicate as activateWatch (no row
  // OR confirmed_at IS NOT NULL flips). Reads only the ancient
  // confirmed_at column (no 010 dependency — recordLogin owns that, and
  // the callback treats it as non-fatal). Fatal like every other
  // watch-row op here: a DB blip denies the login loudly rather than
  // guessing.
  const accountRow = await withSchemaHint(
    db.execute({
      sql: 'SELECT confirmed_at FROM accounts WHERE steam_id = ?',
      args: [steamId],
    }),
  );
  if (
    accountRow.rows.length > 0 &&
    (accountRow.rows[0] as Record<string, unknown>).confirmed_at === null
  ) {
    return { profile: current, activated: false };
  }

  // Atomic gate (same predicate as activateWatch — the SELECT above is
  // only a fast-path short-circuit): the confirmation check lives in
  // the WHERE, so a concurrent signup arming an unconfirmed account
  // between our read and this write can never flip a row that owes a
  // link click. TOCTOU closed by construction, not by timing.
  const flipped = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET status = 'active', activated_at = ?,
                locale = COALESCE(?, locale)
            WHERE steam_id = ? AND status = 'pending'
              ${ACTIVATION_GATE_SQL}`,
      args: [now, normalizeLocale(locale), steamId, steamId, steamId],
    }),
  );
  if (Number(flipped.rowsAffected) === 0) {
    // No flip: either someone else activated concurrently, or the gate
    // above blocked (a concurrent signup armed an unconfirmed account
    // after our fast-path read). Re-read so the caller returns the true
    // current row either way.
    const reread = await withSchemaHint(
      db.execute({
        sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
              FROM watched_profiles WHERE steam_id = ?`,
        args: [steamId],
      }),
    );
    if (reread.rows.length === 0) {
      throw new Error('ensureActiveWatch lost a concurrent race unexpectedly');
    }
    return {
      profile: toWatchedProfile(reread.rows[0] as Record<string, unknown>),
      activated: false,
    };
  }
  return {
    profile: {
      ...current,
      status: 'active',
      activatedAt: now,
      locale: normalizeLocale(locale) ?? current.locale,
    },
    activated: true,
  };
};

/** Current watch status, or null when this profile was never requested. */
export const getWatchStatus = async (
  steamId: string,
): Promise<WatchStatus | null> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: 'SELECT status FROM watched_profiles WHERE steam_id = ?',
      args: [steamId],
    }),
  );
  if (row.rows.length === 0) return null;
  // Unknown values (only possible via hand edits — writes only ever store
  // pending/active) collapse to 'pending', same as toWatchedProfile: the
  // row EXISTS but is not active, so callers gating on === 'active' treat
  // it as inactive while null keeps meaning "never requested".
  // eslint-disable-next-line prefer-destructuring
  const status = row.rows[0].status;
  return status === 'active' ? 'active' : 'pending';
};

/**
 * Lists watched profiles, oldest first — the read side of WB-4
 * reconciliation (the bot converges these against its friendsList
 * snapshot). Optional status filter; anything else throws (fail fast, same
 * contract as the other watch validators).
 *
 * SCALING NOTE: unfiltered full-table scan, no LIMIT. Safe today (one bot,
 * ~250 watches max by the Steam friends cap) but NOT shard-aware: if
 * multi-bot sharding ever happens, this needs a bot/shard predicate (and a
 * matching index) instead of returning every row to every poller.
 */
export const listWatchedProfiles = async (
  status?: WatchStatus,
): Promise<WatchedProfile[]> => {
  assertOptionalWatchStatus(status);
  const db = await getClient();

  const rows = await withSchemaHint(
    status === undefined
      ? db.execute({
          sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
                FROM watched_profiles ORDER BY requested_at ASC, steam_id ASC`,
        })
      : db.execute({
          sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
                FROM watched_profiles WHERE status = ? ORDER BY requested_at ASC, steam_id ASC`,
          args: [status],
        }),
  );

  return rows.rows.map((row) =>
    toWatchedProfile(row as Record<string, unknown>),
  );
};

/**
 * Inbox read side: recorded searches on one profile, newest first — every
 * search SINCE THE WATCH STARTED, with no cooldown gate. The bot keeps
 * its own strict 24h delivery discipline (see watchNotify + notifyPoller);
 * the inbox is the relaxed side: cooldown-suppressed views still appear
 * here, because "who looked me up" must not hide behind a delivery
 * throttle.
 *
 * Temporal floor (`since`, the watch's activated_at ?? requested_at):
 * searches is SHARED analytics — every site search lands here, including
 * ones from before the watch existed. Without the floor, a first-time
 * confirmer would inherit months of strangers' pre-opt-in lookups (and a
 * misleading monthly badge). Null keeps the legacy unfiltered read.
 *
 * Projection (search id + timestamp + cheater flag + searcher country):
 * the inbox renders message text from the shared WB-15 base, the EXISTS
 * adds WHETHER the cheater report was opened for that search, and the
 * LEFT JOIN adds the coarse 2-letter requester country for the inbox
 * flag. That last column is the deliberate exception to the old
 * "no search_meta travels" rule (owner decision: country-level geo only —
 * never IP, city, locale or browser language); rows without search_meta
 * (legacy imports, unknown geo) read back null and render flagless.
 * Limit defaults to WATCH_INBOX_DEFAULT_LIMIT, clamps to
 * [1, WATCH_INBOX_MAX_LIMIT] — an inbox is a recent-history view, not a
 * full export.
 *
 * SCALING NOTE: filters on profiles(steam_id) + ORDER BY searched_at;
 * profiles(steam_id) is indexed by 009, searched_at ordering sorts one
 * profile's rows only (small by construction), so no composite index.
 * The search_meta LEFT JOIN is PK-keyed (search_meta.search_id is the
 * table PK per 001_init) — no extra index needed.
 */
export const listProfileSearches = async (
  steamId: string,
  limit = WATCH_INBOX_DEFAULT_LIMIT,
  since: string | null = null,
): Promise<WatchNotification[]> => {
  assertSteamId64(steamId);
  if (!Number.isFinite(limit)) {
    throw new Error('Invalid search limit: expected a finite number');
  }
  if (
    since !== null &&
    (typeof since !== 'string' || !Number.isFinite(Date.parse(since)))
  ) {
    throw new Error(
      'Invalid since for profile searches: expected an ISO-8601 timestamp or null',
    );
  }
  const n = Math.max(1, Math.min(WATCH_INBOX_MAX_LIMIT, Math.floor(limit)));
  const db = await getClient();

  // Same incremental-clauses shape as countSearchesSince below: one
  // SELECT, so a projection change can never drift between branches.
  const clauses = ['p.steam_id = ?'];
  const args: (string | number)[] = [steamId];
  if (since !== null) {
    clauses.push('s.searched_at >= ?');
    args.push(since);
  }
  args.push(n);
  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT s.id AS search_id, s.searched_at,
              EXISTS (
                SELECT 1 FROM cheater_results c WHERE c.search_id = s.id
              ) AS cheater_checked,
              m.requester_country AS requester_country
            FROM searches s
            JOIN profiles p ON p.search_id = s.id
            LEFT JOIN search_meta m ON m.search_id = s.id
            WHERE ${clauses.join(' AND ')}
            ORDER BY s.searched_at DESC, s.id DESC LIMIT ?`,
      args,
    }),
  );

  return rows.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      searchId: record.search_id as string,
      searchedAt: record.searched_at as string,
      cheaterChecked: Number(record.cheater_checked ?? 0) > 0,
      // Coarse geo only (single choke point: a non-2-letter value from a
      // hand edit or corrupt import degrades to null — flagless row —
      // never to a broken flag or a split bucket).
      requesterCountry: normalizeCountryCode(record.requester_country),
    };
  });
};

/**
 * Unread-count side of the inbox: how many recorded searches sit past a
 * client-supplied search watermark (a searched_at ISO, null for "never
 * opened"). Same source as listProfileSearches — the two can never
 * disagree on what counts.
 *
 * The cursor is searched_at, NOT any id: search ids embed wall-clock
 * time plus randomness, so they are not strictly ordered; searched_at
 * ordering matches the inbox list ordering (searched_at DESC), keeping
 * cursor and display consistent by construction.
 *
 * `watchSince` is the same temporal floor as listProfileSearches (the
 * watch's activated_at ?? requested_at, null for no floor): the watermark
 * cursor stays strict (`>`), the watch floor inclusive (`>=`), and both
 * compose in one predicate.
 *
 * Why server-side: the inbox page is capped (limit ≤ 50), so a client-side
 * filter undercounts once the backlog exceeds the window (30 searches,
 * 20 returned → badge would read 20). The client sends its local watermark
 * as sinceSearchedAt; no `read_at` column needed — the search timestamp
 * IS the cursor.
 */
export const countSearchesSince = async (
  steamId: string,
  sinceSearchedAt: string | null = null,
  watchSince: string | null = null,
): Promise<number> => {
  assertSteamId64(steamId);
  if (
    sinceSearchedAt !== null &&
    (typeof sinceSearchedAt !== 'string' ||
      !Number.isFinite(Date.parse(sinceSearchedAt)))
  ) {
    throw new Error(
      'Invalid sinceSearchedAt for search count: expected an ISO-8601 timestamp or null',
    );
  }
  if (
    watchSince !== null &&
    (typeof watchSince !== 'string' || !Number.isFinite(Date.parse(watchSince)))
  ) {
    throw new Error(
      'Invalid watchSince for search count: expected an ISO-8601 timestamp or null',
    );
  }
  const db = await getClient();

  const clauses = ['p.steam_id = ?'];
  const args: string[] = [steamId];
  if (sinceSearchedAt !== null) {
    clauses.push('s.searched_at > ?');
    args.push(sinceSearchedAt);
  }
  if (watchSince !== null) {
    clauses.push('s.searched_at >= ?');
    args.push(watchSince);
  }
  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM searches s
            JOIN profiles p ON p.search_id = s.id
            WHERE ${clauses.join(' AND ')}`,
      args,
    }),
  );
  const count = Number(row.rows[0]?.n ?? 0);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Monthly search counter for the inbox badge: how many recorded searches
 * targeted this profile since the start of the current UTC calendar month.
 * Counts SEARCHES (every completed search records one), not delivered
 * notifies — cooldown-suppressed views still count as "looked up", which
 * is what the badge promises. `nowMs` is injectable so tests pin the
 * month boundary deterministically; production passes Date.now().
 *
 * `watchSince` is the same temporal floor as listProfileSearches (the
 * watch's activated_at ?? requested_at, null for no floor): the effective
 * floor is the later of month-start and watch start, so a first-day
 * confirmer never inherits a pre-watch monthly total.
 */
export const countSearchesInMonth = async (
  steamId: string,
  nowMs: number = Date.now(),
  watchSince: string | null = null,
): Promise<number> => {
  assertSteamId64(steamId);
  if (!Number.isFinite(nowMs)) {
    throw new Error('Invalid month clock: expected a finite timestamp');
  }
  if (
    watchSince !== null &&
    (typeof watchSince !== 'string' || !Number.isFinite(Date.parse(watchSince)))
  ) {
    throw new Error(
      'Invalid watchSince for monthly count: expected an ISO-8601 timestamp or null',
    );
  }
  const now = new Date(nowMs);
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  ).toISOString();
  // Both bounds are full ISO UTC timestamps: lexicographic max IS the
  // later instant, no Date math needed.
  const floor =
    watchSince !== null && watchSince > monthStart ? watchSince : monthStart;
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM searches s
            JOIN profiles p ON p.search_id = s.id
            WHERE p.steam_id = ? AND s.searched_at >= ?`,
      args: [steamId, floor],
    }),
  );
  const count = Number(row.rows[0]?.n ?? 0);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Transitions pending -> active (+activated_at). Returns true ONLY when
 * THIS call flipped the row (single UPDATE, rowsAffected > 0) — an
 * already-active row returns false. That strictness is load-bearing: two
 * independent activators exist (the confirm route POST and the bot
 * reconcile, unsynchronized across processes), and exactly one of them
 * must own the post-activation side effects (welcome message). Callers
 * treat true as "I flipped it, welcome now" and false as "nothing to do"
 * (missing row, unconfirmed, or someone else flipped first) — never
 * re-read to "confirm", or the duplicate-welcome race returns.
 *
 * Confirmation gate (click-to-activate): the flip additionally requires a
 * CONFIRMED account (confirmed_at IS NOT NULL). Accepting the bot's
 * friendship alone must never activate — otherwise the watch notifies and
 * the site toasts before the user ever clicked the confirm link. The gate
 * is enforced here (not just in callers) so no current or future activator
 * can bypass it by accident; both production callers already satisfy it
 * (reconcile branches on confirmation first, the confirm route activates
 * right after consuming the token).
 *
 * Legacy carve-out: a pending watch with NO accounts row at all (created
 * before the confirmation epic, when friendship was the whole opt-in)
 * still activates. Those users consented under the old contract and have
 * no link to click; stranding their notifications would be a regression,
 * not a fix. New flows always create the account row at signup, so the
 * carve-out only ever matches pre-confirmation rows and hand edits.
 */
export const activateWatch = async (steamId: string): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET status = 'active', activated_at = ?
            WHERE steam_id = ? AND status = 'pending'
              ${ACTIVATION_GATE_SQL}`,
      args: [new Date().toISOString(), steamId, steamId, steamId],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

/**
 * Opt-out: deletes the watched_profiles row (PII removal — steam_id +
 * locale). watch_events rows intentionally survive (no FK by design): the
 * event log carries no email/locale, only the public steam_id, and the
 * inbox history + ops audit stay intact. Returns false when nothing was
 * stored for this profile.
 */
export const deactivateWatch = async (steamId: string): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const deleted = await withSchemaHint(
    db.execute({
      sql: 'DELETE FROM watched_profiles WHERE steam_id = ?',
      args: [steamId],
    }),
  );
  return Number(deleted.rowsAffected) > 0;
};

/**
 * Deletes the accounts row (steam_id + locale + confirmation timestamps).
 * Granular primitive, kept exported for tests — production opt-out goes
 * through removeWatchAndAccount below, never this alone: without the
 * account delete, unfriending would leave a permanent record behind and a
 * future re-signup would silently skip confirmation on the stale
 * confirmed_at. Deliberately NOT called by the signup compensation path
 * (a failed enqueue is a system error, not user intent — the account
 * stays so the retry is idempotent). Returns false when no account row
 * existed.
 */
export const deleteAccount = async (steamId: string): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const deleted = await withSchemaHint(
    db.execute({
      sql: 'DELETE FROM accounts WHERE steam_id = ?',
      args: [steamId],
    }),
  );
  return Number(deleted.rowsAffected) > 0;
};

export interface RemoveWatchResult {
  watchDeleted: boolean;
  accountDeleted: boolean;
}

/**
 * Opt-out, the ONLY production path that removes user rows (the live
 * friend-remove handler and the offline reconcile pass share it, so the
 * rule can never drift between two reimplementations again): deletes the
 * accounts row AND the watched_profiles row in ONE db.batch() — a single
 * transaction, so both go or neither does. No orphan window, no retry or
 * sweep machinery, and a failure reports {false, false} truthfully (the
 * batch rolled back — nothing was removed). A fresh opt-out cycle means
 * fresh consent: the next signup starts unconfirmed and the bot sends a
 * new link.
 *
 * History links are DELIBERATELY preserved (product decision): unfriending
 * only HIDES the history — the modal gates on the accounts footprint and
 * stops showing entries until the user re-adds the bot, at which point
 * the old links (keyed by the stable SteamID) resurface together with
 * new ones. Only the explicit "Clear my history" (deleteSearcherHistory)
 * and the 12-month TTL purge cut links. See also deactivateWatch, the
 * watch-only variant the swap procedure uses when even the accounts row
 * must survive.
 *
 * No re-attribution residual: the iron-session cookie (30-day TTL)
 * survives unfriending, but recordSearch attributes atomically on a
 * live ACCOUNTS row — and this just deleted it. A still-valid cookie
 * therefore records anonymously until the user signs up again (fresh
 * consent model, same as re-signup).
 */

export const removeWatchAndAccount = async (
  steamId: string,
): Promise<RemoveWatchResult> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const deleteStatements = [
    {
      sql: 'DELETE FROM accounts WHERE steam_id = ?',
      args: [steamId],
    },
    {
      sql: 'DELETE FROM watched_profiles WHERE steam_id = ?',
      args: [steamId],
    },
  ];

  // No 020-pending handling needed here anymore: neither DELETE touches
  // the searcher column (history links survive opt-out by product
  // decision — only deleteSearcherHistory and the TTL purge cut them),
  // so a pending migration cannot break this batch. withSchemaHint stays
  // for genuinely missing tables (fresh DB without any migration).
  const results = await withSchemaHint(db.batch(deleteStatements));

  return {
    accountDeleted: Number(results?.[0]?.rowsAffected) > 0,
    watchDeleted: Number(results?.[1]?.rowsAffected) > 0,
  };
};

/**
 * "Clear my history": cuts every who-searched-whom link for one viewer
 * (UPDATE ... SET NULL, never DELETE — the searches themselves stay for
 * the dashboard aggregates and the targets' inboxes, which never show
 * searcher identity). Called by DELETE /api/history (session identity)
 * and shared with nothing else. Returns the de-attributed row count.
 *
 * This is the ONLY user-triggered link cut (plus the TTL purge):
 * unfriending hides history via the footprint gate but preserves the
 * links, which resurface if the user re-adds the bot.
 */
export const deleteSearcherHistory = async (
  searcherSteamId: string,
): Promise<number> => {
  assertSteamId64(searcherSteamId);
  const db = await getClient();

  const result = await withSchemaHint(
    db.execute({
      sql: 'UPDATE searches SET searcher_steam_id = NULL WHERE searcher_steam_id = ?',
      args: [searcherSteamId],
    }),
  );
  const count = Number(result.rowsAffected ?? 0);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Retention purge (history TTL): cuts the who-searched-whom link on every
 * row whose SEARCH ran before `olderThanIso`, keeping the searches
 * themselves (aggregates and inboxes never show searcher identity, so
 * they are unaffected). Called by the bot's daily history-purge pass —
 * never by request handlers (no user-triggered bulk UPDATE). The cutoff
 * is a wall-clock ISO string against searches.searched_at (always
 * toISOString at write, so lexicographic comparison orders correctly);
 * garbage in is a throw, never a silent full-table wipe.
 *
 * Plain range UPDATE: EXPLAIN shows it driving idx_searches_searched_at
 * (old rows first — mostly anonymous) rather than the partial
 * composite. Either way indexed, never a full scan.
 */
export const purgeExpiredSearcherLinks = async (
  olderThanIso: string,
): Promise<number> => {
  if (
    typeof olderThanIso !== 'string' ||
    olderThanIso.length === 0 ||
    !Number.isFinite(Date.parse(olderThanIso))
  ) {
    throw new Error(
      'Invalid retention cutoff: expected a parseable ISO-8601 timestamp',
    );
  }
  const db = await getClient();

  const result = await withSchemaHint(
    db.execute({
      sql: `UPDATE searches SET searcher_steam_id = NULL
            WHERE searcher_steam_id IS NOT NULL AND searched_at < ?`,
      args: [olderThanIso],
    }),
  );
  const count = Number(result.rowsAffected ?? 0);
  return Number.isFinite(count) ? count : 0;
};

export interface EnqueueWatchEventResult {
  eventId: number | null;
  /** True when a notify for this search_id was already queued (no new row). */
  duplicate: boolean;
}

/**
 * Appends an outbox event. Notify events carry the producing search_id and
 * are idempotent per search: a second enqueue for the same search_id
 * returns { duplicate: true } without inserting (explicit pre-check instead
 * of parsing a UNIQUE violation, repo convention) — PLUS a catch backstop
 * for the concurrent-duplicate race below, so the idempotency guarantee
 * holds under concurrency, not just sequentially. Invite events carry no
 * search (null); per-profile invite discipline is "at most one OPEN invite
 * per profile", enforced by the partial unique index
 * idx_watch_events_open_invite (004 migration) with the same
 * catch-and-re-read backstop for the race the index turns into a UNIQUE
 * violation. Epic 3+ endpoint policy (getWatchStatus before enqueueing)
 * sits on top of this guarantee, not instead of it.
 *
 * NOTE: this does not check watch status — the Epic 4 hook gates on
 * getWatchStatus + isWithinCooldown before enqueueing. The 'welcome' and
 * 'confirm_resend' lanes likewise carry no search_id (like 'invite'):
 * welcome events are emitted by the confirm route after a click, resend
 * requests by the resend route — one row per request, throttling enforced
 * by the fulfilling bot poller, not here.
 */
// Single source of truth for "an invite event is still open" (queued or
// claimed — sent/dropped history never blocks a fresh invite). Shared by
// the enqueueEvent dedupe pre-check, the race catch below, and
// hasOpenInviteEvent, so the three WHERE clauses cannot drift apart.
const OPEN_INVITE_PREDICATE_SQL = `kind = 'invite' AND status IN ('queued', 'claimed')`;

/** Open invite id for this profile, or null when none is open. */
const readOpenInviteId = async (
  db: Client,
  steamId: string,
): Promise<number | null> => {
  const open = await withSchemaHint(
    db.execute({
      sql: `SELECT id FROM watch_events
            WHERE steam_id = ? AND ${OPEN_INVITE_PREDICATE_SQL}
            LIMIT 1`,
      args: [steamId],
    }),
  );
  if (open.rows.length === 0) return null;
  return Number(open.rows[0].id);
};

export const enqueueEvent = async (
  steamId: string,
  kind: WatchEventKind,
  searchId?: string | null,
): Promise<EnqueueWatchEventResult> => {
  assertSteamId64(steamId);
  assertWatchEventKind(kind);
  if (searchId !== undefined && searchId !== null) {
    if (typeof searchId !== 'string' || searchId.length === 0) {
      throw new Error(
        'Invalid searchId for watch event: expected non-empty string',
      );
    }
  }
  const db = await getClient();

  if (searchId != null) {
    const existing = await withSchemaHint(
      db.execute({
        sql: 'SELECT id FROM watch_events WHERE search_id = ?',
        args: [searchId],
      }),
    );
    if (existing.rows.length > 0) {
      return { eventId: Number(existing.rows[0].id), duplicate: true };
    }
  }

  if (kind === 'invite' && searchId == null) {
    // Per-profile invite discipline: at most one open invite event per
    // profile. Sequential duplicates (double-click, client retry, refresh
    // then re-request) collapse here instead of producing a second
    // addFriend for the same target. A genuinely concurrent double-submit
    // that slips past this read hits the partial unique index instead and
    // is collapsed in the catch below. Events already sent/dropped do NOT
    // block: a new invite after expiry must go through.
    const openId = await readOpenInviteId(db, steamId);
    if (openId !== null) {
      return { eventId: openId, duplicate: true };
    }
  }

  const now = new Date().toISOString();
  const insertSql = `INSERT INTO watch_events
              (search_id, steam_id, kind, status, created_at, claimed_at, sent_at)
              VALUES (?, ?, ?, 'queued', ?, NULL, NULL)`;
  const insertArgs: (string | null)[] = [searchId ?? null, steamId, kind, now];
  let inserted;
  try {
    inserted = await withSchemaHint(
      db.execute({ sql: insertSql, args: insertArgs }),
    );
  } catch (error) {
    // Two callers can both pass the pre-check above and collide on
    // UNIQUE(search_id) — e.g. a reinvoked serverless function after a
    // timeout. The loser re-reads the winner's row and reports duplicate
    // instead of throwing, which matters because the Epic 4 caller is
    // fire-and-forget: an unhandled rejection there is worse than anywhere
    // else this pre-check pattern is used. Anything that is NOT a unique
    // violation still propagates untouched.
    if (!isUniqueViolation(error)) throw error;
    if (searchId != null) {
      const winner = await withSchemaHint(
        db.execute({
          sql: 'SELECT id FROM watch_events WHERE search_id = ?',
          args: [searchId],
        }),
      );
      if (winner.rows.length === 0) {
        // Vanished between the failed INSERT and this read (nothing in the
        // app deletes events). Report duplicate anyway: the search was
        // provably seen, and proceeding untracked would risk a second send
        // with no idempotency row.
        return { eventId: null, duplicate: true };
      }
      return { eventId: Number(winner.rows[0].id), duplicate: true };
    }
    // Invite race loser (partial unique index idx_watch_events_open_invite):
    // the winner's open row is the duplicate to report. If it settled
    // (sent/dropped) in the microseconds between the violation and this
    // read, the path is clear again — retry the INSERT once rather than
    // reporting a phantom duplicate over a row that no longer blocks.
    const winnerId = await readOpenInviteId(db, steamId);
    if (winnerId !== null) {
      return { eventId: winnerId, duplicate: true };
    }
    try {
      inserted = await withSchemaHint(
        db.execute({ sql: insertSql, args: insertArgs }),
      );
    } catch (retryError) {
      if (!isUniqueViolation(retryError)) throw retryError;
      // A second consecutive violation means a new open row landed under
      // us — report whatever is open now (null is practically unreachable
      // here, but keeps the return type honest instead of throwing on a
      // state the caller cannot act on).
      return { eventId: await readOpenInviteId(db, steamId), duplicate: true };
    }
  }

  const eventId = Number(inserted.lastInsertRowid ?? NaN);
  return {
    eventId: Number.isFinite(eventId) ? eventId : null,
    duplicate: false,
  };
};

/**
 * Atomically claims up to `limit` queued events of one lane for the calling
 * poller. `limit` semantics: <= 0 means "no capacity" and returns [] without
 * touching the database (a poller computing remaining capacity legitimately
 * passes 0); non-finite values throw (programmer error, same fail-fast
 * contract as resetStaleClaims/isWithinCooldown); above 100 clamps to 100
 * so one poller can never starve the lane in a single grab.
 *
 * Single-statement UPDATE ... RETURNING: two concurrent pollers can never
 * receive the same row (no read-then-write race), and lanes never contend
 * (kind is in the predicate). Claimed rows must be settled with
 * markEventSent/markEventDropped; orphans are requeued by resetStaleClaims.
 *
 * The inner SELECT picks the N oldest queued rows, but SQLite does not
 * guarantee RETURNING preserves that order — so the result is sorted by id
 * here, and pollers can rely on FIFO without sorting again.
 */
export const claimNextQueuedEvents = async (
  kind: WatchEventKind,
  limit = 10,
): Promise<WatchEvent[]> => {
  assertWatchEventKind(kind);
  if (!Number.isFinite(limit)) {
    throw new Error('Invalid claim limit: expected a finite number');
  }
  const n = Math.max(0, Math.min(100, Math.floor(limit)));
  const db = await getClient();
  if (n === 0) return [];

  const claimed = await withSchemaHint(
    db.execute({
      sql: `UPDATE watch_events SET status = 'claimed', claimed_at = ?
            WHERE id IN (
              SELECT id FROM watch_events
              WHERE kind = ? AND status = 'queued'
              ORDER BY id ASC LIMIT ?
            )
            RETURNING id, search_id, steam_id, kind, status, created_at, claimed_at, sent_at`,
      args: [new Date().toISOString(), kind, n],
    }),
  );

  return claimed.rows
    .map((row) => toWatchEvent(row as Record<string, unknown>))
    .sort((a, b) => a.id - b.id);
};

/**
 * Settles a claimed event as sent. Only rows this worker claimed transition
 * (status='claimed' predicate) — completing an event owned by someone else
 * (or already settled) returns false instead of corrupting it.
 *
 * The profile cooldown clock (last_notified_at) advances in the SAME batch,
 * but guarded by the sent_at timestamp this very call just wrote — NOT by
 * id/kind alone. That distinction matters: without the sent_at guard, a
 * duplicate markEventSent (idempotent retry, crash reprocessing, double
 * call) would return false yet STILL push the cooldown forward, and marking
 * a never-claimed event would record a notification that was never sent,
 * suppressing legitimate notifies for a full window with zero symptoms.
 * Same-transaction visibility makes the guard exact: if the first statement
 * touched nothing, no row carries this call's sent_at and the second is a
 * guaranteed no-op.
 */
export const markEventSent = async (id: number): Promise<boolean> => {
  const db = await getClient();
  const now = new Date().toISOString();

  const results = await withSchemaHint(
    db.batch([
      {
        sql: `UPDATE watch_events SET status = 'sent', sent_at = ?
              WHERE id = ? AND status = 'claimed'`,
        args: [now, id],
      },
      {
        sql: `UPDATE watched_profiles SET last_notified_at = ?
              WHERE steam_id = (
                SELECT steam_id FROM watch_events
                WHERE id = ? AND kind = 'notify' AND sent_at = ?
              )`,
        args: [now, id, now],
      },
    ]),
  );

  return Number(results?.[0]?.rowsAffected) > 0;
};

/** Settles a claimed event as dropped (undeliverable, expired, superseded). */
export const markEventDropped = async (id: number): Promise<boolean> => {
  const db = await getClient();

  const dropped = await withSchemaHint(
    db.execute({
      sql: `UPDATE watch_events SET status = 'dropped', sent_at = ?
            WHERE id = ? AND status = 'claimed'`,
      args: [new Date().toISOString(), id],
    }),
  );
  return Number(dropped.rowsAffected) > 0;
};

/**
 * Crash recovery: requeues claims orphaned by a dead worker (claimed_at
 * older than the window) back to 'queued' so another poller retries them.
 * Returns how many rows were requeued. At-least-once by design: a message
 * sent but unmarked before the crash MAY send twice — chat messages are
 * naturally idempotent-ish, and notify dedupe still holds at enqueue time
 * (one queued row per search_id, never re-enqueued for the same search).
 */
export const resetStaleClaims = async (
  olderThanMinutes = 30,
): Promise<number> => {
  if (!Number.isFinite(olderThanMinutes) || olderThanMinutes <= 0) {
    throw new Error(
      'Invalid resetStaleClaims window: expected positive minutes',
    );
  }
  const db = await getClient();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60000).toISOString();

  const requeued = await withSchemaHint(
    db.execute({
      sql: `UPDATE watch_events SET status = 'queued', claimed_at = NULL
            WHERE status = 'claimed' AND claimed_at < ?`,
      args: [cutoff],
    }),
  );
  return Number(requeued.rowsAffected) || 0;
};

/**
 * Cooldown check for the Epic 4 notify hook: true when this profile was
 * notified within the last `windowHours`. Missing row or missing timestamp
 * fail OPEN (false) — a corrupt/absent clock must never silently suppress
 * notifications forever. The timestamp math itself lives in
 * @/lib/watch/cooldown (shared with the bot's send-time recheck).
 */
export const isWithinCooldown = async (
  steamId: string,
  windowHours: number,
): Promise<boolean> => {
  assertSteamId64(steamId);
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    throw new Error('Invalid cooldown window: expected positive hours');
  }
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: 'SELECT last_notified_at FROM watched_profiles WHERE steam_id = ?',
      args: [steamId],
    }),
  );
  if (row.rows.length === 0) return false;
  const last = row.rows[0].last_notified_at;
  return isWithinCooldownWindow(
    typeof last === 'string' ? last : null,
    windowHours,
  );
};

/** Full watched row, or null when this profile was never requested. */
export const getWatchedProfile = async (
  steamId: string,
): Promise<WatchedProfile | null> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, status, locale, requested_at, activated_at, last_notified_at
            FROM watched_profiles WHERE steam_id = ?`,
      args: [steamId],
    }),
  );
  if (row.rows.length === 0) return null;
  return toWatchedProfile(row.rows[0] as Record<string, unknown>);
};

// ---------------------------------------------------------------------------
// Bot heartbeat (bot-liveness bridge for the site's sign-in gate).
// The bot process mirrors its local heartbeat file into this single-row
// table every BOT_HEARTBEAT_INTERVAL_MS; the Vercel navbar reads it to
// hide the sign-in button while the bot is offline (it cannot read the
// file across hosts). See migrations/011_bot_heartbeat.sql.
// ---------------------------------------------------------------------------

/** Upserts the single heartbeat row (id=1, never grows). Best-effort by
 * contract — callers (the bot process) must never crash on a DB blip.
 *
 * `disconnected_since` is maintained ATOMICALLY in this one statement (no
 * read-modify-write, so overlapping beats can never race): a connected
 * beat clears it; a disconnected beat keeps the EARLIEST existing value
 * (COALESCE), so the site's liveness gate (botLiveness.ts) always
 * measures the true sustained-disconnect duration — a bot process alive
 * behind a dead Steam session (banned account, pending Guard, long Steam
 * outage) keeps beating fresh, and this column is what lets the gate hide
 * the sign-in button for that class instead of only for a dead process. */
export const recordBotHeartbeat = async (
  connected: boolean,
  steamId: string | null,
): Promise<void> => {
  const db = await getClient();
  const beatAt = new Date().toISOString();
  const connectedFlag = toSqlBool(connected);
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO bot_heartbeat (id, beat_at, connected, steam_id, disconnected_since)
            VALUES (1, ?, ?, ?, CASE WHEN ? = 1 THEN NULL ELSE ? END)
            ON CONFLICT(id) DO UPDATE SET
              beat_at = excluded.beat_at,
              connected = excluded.connected,
              steam_id = excluded.steam_id,
              disconnected_since = CASE
                WHEN excluded.connected = 1 THEN NULL
                ELSE COALESCE(bot_heartbeat.disconnected_since, excluded.beat_at)
              END`,
      args: [beatAt, connectedFlag, steamId, connectedFlag, beatAt],
    }),
  );
};

export interface BotHeartbeat {
  /** ISO-8601 of the last beat write (the liveness clock). */
  beatAt: string;
  /** Whether the Steam session was connected at write time. */
  connected: boolean;
  steamId: string | null;
  /**
   * ISO-8601 of when the Steam session FIRST went disconnected in the
   * current streak (null while connected, and for legacy rows written
   * before the column existed — readers must treat null as "unknown
   * duration", never as "no disconnection"). Maintained by
   * recordBotHeartbeat's upsert; read by the site's liveness gate as the
   * sustained-outage clock.
   */
  disconnectedSince: string | null;
}

/** Latest heartbeat row, or null when the bot never wrote (migration not
 * yet run / bot not deployed). Null is the liveness gate's fail-open case. */
export const getBotHeartbeat = async (): Promise<BotHeartbeat | null> => {
  const db = await getClient();
  const row = await withSchemaHint(
    db.execute({
      sql: 'SELECT beat_at, connected, steam_id, disconnected_since FROM bot_heartbeat WHERE id = 1',
    }),
  );
  if (row.rows.length === 0) return null;
  const record = row.rows[0] as Record<string, unknown>;
  return {
    beatAt: String(record.beat_at),
    connected: Number(record.connected) > 0,
    steamId: typeof record.steam_id === 'string' ? record.steam_id : null,
    disconnectedSince:
      typeof record.disconnected_since === 'string'
        ? record.disconnected_since
        : null,
  };
};

/**
 * Read-only Watch aggregates for the analytics dashboard (no migration, no
 * writes — these tables already exist). Four SELECTs in ONE db.batch(), so
 * the funnel, deliveries and liveness snapshot share one instant instead
 * of drifting across sequential reads (same rationale as getSearchRecords).
 *
 * Column allowlist by construction: token hashes, anti-loop state and
 * session material are never selected, so they cannot leak into the
 * dashboard payload. Malformed rows (hand edits, legacy imports) are
 * dropped when a required timestamp is missing — a corrupt row must not
 * poison dashboard aggregates with NaN buckets.
 */
export const getWatchDashboardData = async (): Promise<WatchDashboardData> => {
  // Full-table reads, same pattern as getSearchRecords (no pagination):
  // watch_events grows one row per bot delivery, faster than searches.
  // Acceptable at current scale (single bot, friend-cap-bounded watches);
  // if it ever dominates page cost, aggregate in SQL (GROUP BY day/kind +
  // 31-day window) instead of shipping rows for the client to bucket —
  // and note the bucketing timezone would move from browser-local to UTC.
  // No ORDER BY: the client only buckets/counts, order is irrelevant and an
  // unindexed sort is pure cost.
  const db = await getClient();

  const [accounts, watched, events, heartbeat] = await withSchemaHint(
    db.batch([
      {
        sql: 'SELECT created_at, confirmed_at, locale, last_login_at FROM accounts',
      },
      {
        sql: 'SELECT status, locale, requested_at, activated_at FROM watched_profiles',
      },
      {
        sql: 'SELECT kind, status, created_at, sent_at FROM watch_events',
      },
      { sql: 'SELECT beat_at, connected FROM bot_heartbeat WHERE id = 1' },
    ]),
  );

  const accountRows: WatchDashboardAccount[] = [];
  accounts.rows.forEach((row) => {
    if (typeof row.created_at !== 'string') return;
    accountRows.push({
      createdAt: row.created_at,
      confirmedAt:
        typeof row.confirmed_at === 'string' ? row.confirmed_at : null,
      locale: typeof row.locale === 'string' ? row.locale : null,
      lastLoginAt:
        typeof row.last_login_at === 'string' ? row.last_login_at : null,
    });
  });

  const watchedRows: WatchDashboardWatched[] = [];
  watched.rows.forEach((row) => {
    if (typeof row.requested_at !== 'string') return;
    watchedRows.push({
      requestedAt: row.requested_at,
      activatedAt:
        typeof row.activated_at === 'string' ? row.activated_at : null,
      // Same collapse as toWatchedProfile: unknown statuses read as
      // pending rather than leaking a third state into the funnel.
      status: row.status === 'active' ? 'active' : 'pending',
      locale: typeof row.locale === 'string' ? row.locale : null,
    });
  });

  const validKinds: WatchEventKind[] = [
    'invite',
    'notify',
    'welcome',
    'confirm_resend',
    // ban_alert included: the sweep's reveal alerts are deliveries too —
    // omitting the kind silently drops the whole lane from the panel
    // (the client derives lanes from the data, so no template change).
    'ban_alert',
  ];
  const eventRows: WatchDashboardEvent[] = [];
  events.rows.forEach((row) => {
    if (
      typeof row.created_at !== 'string' ||
      typeof row.kind !== 'string' ||
      !(validKinds as string[]).includes(row.kind) ||
      typeof row.status !== 'string'
    ) {
      return;
    }
    eventRows.push({
      kind: row.kind as WatchEventKind,
      // Statuses are writer-owned ('queued'|'claimed'|'sent'|'dropped');
      // an unknown one passes through verbatim and simply never matches a
      // sent/dropped bucket client-side — fail-open, same rationale.
      status: row.status as WatchEventStatus,
      createdAt: row.created_at,
      sentAt: typeof row.sent_at === 'string' ? row.sent_at : null,
    });
  });

  const beatRow = heartbeat.rows[0] as Record<string, unknown> | undefined;
  return {
    accounts: accountRows,
    watched: watchedRows,
    events: eventRows,
    liveness:
      beatRow !== undefined && typeof beatRow.beat_at === 'string'
        ? {
            beatAt: beatRow.beat_at,
            connected: Number(beatRow.connected) > 0,
          }
        : null,
    generatedAt: new Date().toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Watch accounts (navbar-global signup + bot-link confirmation).
// ---------------------------------------------------------------------------

const toWatchAccount = (row: Record<string, unknown>): WatchAccount => ({
  steamId: row.steam_id as string,
  createdAt: row.created_at as string,
  confirmedAt:
    typeof row.confirmed_at === 'string' ? row.confirmed_at : null,
  confirmTokenHash:
    typeof row.confirm_token_hash === 'string'
      ? row.confirm_token_hash
      : null,
  confirmExpiresAt:
    typeof row.confirm_expires_at === 'string'
      ? row.confirm_expires_at
      : null,
  locale: typeof row.locale === 'string' ? row.locale : null,
  lastLoginAt:
    typeof row.last_login_at === 'string' ? row.last_login_at : null,
});

/**
 * Single SHA-256-hex helper behind both token hashers (confirm + anti-loop
 * are the identical construction by design, not by accident): one place
 * to change if the digest ever needs to evolve, and the two public names
 * stay stable for their distinct call sites.
 */
const sha256Hex = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/**
 * SHA-256 hex of a confirmation token. Only hashes are stored and
 * compared — the plaintext token exists transiently in the signup response
 * (bot message) and the confirm query string, never in the database or
 * (via sanitizeError-safe callers) in logs.
 */
export const hashConfirmToken = (token: string): string => sha256Hex(token);

/**
 * Creates the account row. Idempotent like createWatchRequest: an existing
 * row (confirmed or not) is returned untouched — re-signup never resets
 * confirmation state and concurrent signups cannot duplicate the row.
 */
export const createAccount = async (
  steamId: string,
  locale?: string | null,
): Promise<WatchAccount> => {
  assertSteamId64(steamId);
  const db = await getClient();
  const now = new Date().toISOString();

  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO accounts
            (steam_id, created_at, confirmed_at, confirm_token_hash, confirm_expires_at, locale)
            VALUES (?, ?, NULL, NULL, NULL, ?)
            ON CONFLICT(steam_id) DO NOTHING`,
      args: [steamId, now, normalizeLocale(locale)],
    }),
  );

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, created_at, confirmed_at, confirm_token_hash, confirm_expires_at, locale
            FROM accounts WHERE steam_id = ?`,
      args: [steamId],
    }),
  );

  // Same unreachable-unless-deleted contract as createWatchRequest (nothing
  // in the app deletes accounts): throw rather than fabricate a row.
  if (row.rows.length === 0) {
    throw new Error('createAccount lost a concurrent race unexpectedly');
  }

  return toWatchAccount(row.rows[0] as Record<string, unknown>);
};

/** Full account row, or null when this profile never signed up. */
export const getAccount = async (
  steamId: string,
): Promise<WatchAccount | null> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, created_at, confirmed_at, confirm_token_hash, confirm_expires_at, locale, last_login_at
            FROM accounts WHERE steam_id = ?`,
      args: [steamId],
    }),
  );
  if (row.rows.length === 0) return null;
  return toWatchAccount(row.rows[0] as Record<string, unknown>);
};

/**
 * Login registry write (single-state model: the LOGIN path writes
 * accounts through here — createAccount remains the writer for the
 * signup and history-reconnect lanes). Idempotent upsert:
 * first login inserts the row (created_at pinned, never reset);
 * every login refreshes last_login_at and the locale when provided.
 * Concurrent first logins converge on one row (PK conflict → update).
 */
export const recordLogin = async (
  steamId: string,
  locale?: string | null,
): Promise<WatchAccount> => {
  assertSteamId64(steamId);
  const db = await getClient();
  const now = new Date().toISOString();

  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO accounts (steam_id, created_at, locale, last_login_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(steam_id) DO UPDATE SET
              last_login_at = excluded.last_login_at,
              locale = COALESCE(excluded.locale, accounts.locale)`,
      args: [steamId, now, normalizeLocale(locale), now],
    }),
  );

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, created_at, confirmed_at, confirm_token_hash, confirm_expires_at, locale, last_login_at
            FROM accounts WHERE steam_id = ?`,
      args: [steamId],
    }),
  );

  // Same unreachable-unless-deleted contract as createWatchRequest (only
  // opt-out deletes accounts, and no concurrent path does that mid-login).
  // Throw rather than fabricate a row.
  if (row.rows.length === 0) {
    throw new Error('recordLogin lost a concurrent race unexpectedly');
  }

  return toWatchAccount(row.rows[0] as Record<string, unknown>);
};

// ---------------------------------------------------------------------------
// Steam-login funnel instrumentation (login_cta_clicked -> login_completed).
// One row per event; conversion is derived per anonymous session at read
// time (getLoginFunnelStats), never stored. Both writers are best-effort:
// the CTA beacon is fire-and-forget client-side, and the completion hook in
// completeProvenLogin catches (a failed funnel write costs a log line,
// never the login — same contract as the recordLogin audit above).
// ---------------------------------------------------------------------------

/** Row written by recordLoginFunnelEvent (mirrors the 017-widened CHECK + nullables). */
export type LoginFunnelEventInput = {
  event: LoginFunnelEventKind;
  /** Anon browser UUID; null when the CTA cookie was absent/unreadable. */
  sessionId: string | null;
  /** Active search at click time; null outside a search. */
  searchId: string | null;
};

/**
 * Appends one funnel event. Single INSERT (no batch — one row, nothing to
 * make atomic with). Throws on transport failure so routes can log loudly;
 * every caller treats it as non-fatal.
 */
export const recordLoginFunnelEvent = async (
  input: LoginFunnelEventInput,
): Promise<void> => {
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO login_funnel_events (event, session_id, search_id, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [
        input.event,
        input.sessionId,
        input.searchId,
        new Date().toISOString(),
      ],
    }),
  );
};

// ---------------------------------------------------------------------------
// Login-prompt popup funnel (shown -> CTA click -> attributed signin).
// Same best-effort contract as the navbar funnel: writers never throw
// into product code paths, readers degrade to zeros (never NaN).
// Declared BEFORE getLoginFunnelStats (which reads it) to satisfy
// no-use-before-define — narrative order, not execution order.
// ---------------------------------------------------------------------------

/** Row written by recordLoginPopupEvent (mirrors 016 CHECK + nullables). */
export type LoginPopupEventInput = {
  event: LoginPopupEventKind;
  /** Anon browser UUID; null when storage/cookie unavailable. */
  sessionId: string | null;
  /** Active search at event time; null outside a search. */
  searchId: string | null;
};

/**
 * Appends one popup event. Single INSERT, same throw-to-log contract as
 * recordLoginFunnelEvent (callers treat it as non-fatal).
 */
export const recordLoginPopupEvent = async (
  input: LoginPopupEventInput,
): Promise<void> => {
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO login_popup_events (event, session_id, search_id, created_at)
            VALUES (?, ?, ?, ?)`,
      args: [
        input.event,
        input.sessionId,
        input.searchId,
        new Date().toISOString(),
      ],
    }),
  );
};

type DbClient = Awaited<ReturnType<typeof getClient>>;

/**
 * Popup aggregates, read together with the navbar funnel (shared snapshot
 * would need a transaction across two independent domains — instead both
 * reads are single statements back-to-back; counts this small never drift
 * observably between them).
 *
 * Attribution is a TEMPORAL join, not a bare intersection: a signin counts
 * for the popup only when its session recorded a popup CTA click strictly
 * BEFORE the completion (ISO-8601 strings compare lexicographically, so
 * the ordering is exact without date parsing). A completion that precedes
 * any popup click (e.g. user logged in via navbar first, saw the popup
 * later — impossible while logged in, but defensive) never attributes.
 * NULL-session completions can never attribute (no session to join on).
 */
export const getLoginPopupStats = async (
  db?: DbClient,
): Promise<LoginPopupStats> => {
  const client = db ?? (await getClient());
  const result = await withSchemaHint(
    client.execute({
      sql: `SELECT
              COALESCE(SUM(CASE WHEN event = 'login_popup_shown' THEN 1 ELSE 0 END), 0) AS popup_shown,
              COUNT(DISTINCT CASE WHEN event = 'login_popup_shown' THEN session_id END) AS popup_shown_sessions,
              COALESCE(SUM(CASE WHEN event = 'login_popup_cta_clicked' THEN 1 ELSE 0 END), 0) AS popup_clicks,
              COUNT(DISTINCT CASE WHEN event = 'login_popup_cta_clicked' THEN session_id END) AS popup_click_sessions,
              COUNT(DISTINCT CASE
                WHEN p.event = 'login_popup_cta_clicked'
                  AND EXISTS (
                    SELECT 1 FROM login_funnel_events f
                    WHERE f.event = 'login_completed'
                      AND f.session_id = p.session_id
                      AND f.created_at > p.created_at
                  )
                THEN p.session_id
              END) AS popup_attributed_signins
            FROM login_popup_events p`,
    }),
  );

  const toCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;

  const popupClickSessions = toCount(row.popup_click_sessions);
  const popupAttributedSignins = toCount(row.popup_attributed_signins);

  return {
    popupShown: toCount(row.popup_shown),
    popupShownSessions: toCount(row.popup_shown_sessions),
    popupClicks: toCount(row.popup_clicks),
    popupClickSessions,
    popupAttributedSignins,
    popupConversionRate:
      popupClickSessions > 0
        ? (popupAttributedSignins / popupClickSessions) * 100
        : null,
  };
};

/**
 * Popup read isolated from the navbar-funnel read below. The real rollout
 * case is a DB with 015 applied but 016 pending (migrations apply in
 * order) — a missing login_popup_events table must degrade ONLY the popup
 * cards to zeros, never null out the whole funnel panel. Only the
 * missing-schema shape is swallowed; transport/logic errors still throw
 * so the route's fail-open null keeps working.
 */
const readPopupStatsIsolated = async (
  db: DbClient,
): Promise<LoginPopupStats> => {
  try {
    return await getLoginPopupStats(db);
  } catch (error) {
    if (error instanceof Error && SCHEMA_MISSING_PATTERN.test(error.message)) {
      return {
        popupShown: 0,
        popupShownSessions: 0,
        popupClicks: 0,
        popupClickSessions: 0,
        popupAttributedSignins: 0,
        popupConversionRate: null,
      };
    }
    throw error;
  }
};

/**
 * Read-only funnel aggregates for the analytics dashboard. One conditional-
 * aggregation query (single row, single snapshot); the rate is derived in
 * JS. Throws when the table is missing (migration not run) — the dashboard
 * route treats that as fail-open null, same as the Watch half.
 *
 * completedSessions is an INTERSECTION, not an independent DISTINCT: a
 * session only counts as "converted" when it ALSO has a recorded CTA click.
 * The CTA beacon is best-effort (ad-blockers on the /recordAnalyticsLogin
 * URL pattern, keepalive lost to the navigation, network blip) while the
 * completion hook is server-side and reliable — so completions whose click
 * row was lost DO appear in the raw `completions` total but never in the
 * rate. Without the intersection the rate could exceed 100% exactly when
 * beacons fail most (privacy extensions), lying about the funnel in the
 * direction that matters. Repeat clicks / re-logins also move only the raw
 * counts: the per-session DISTINCT keeps them out of both sides.
 *
 * Mid-step columns (017) split the click→completion gap in two: returns
 * vs abandon at Steam's page, and waiting-room entry vs leak. Same
 * best-effort caveat throughout: a NULL-session mid-step row (ctx cookie
 * absent/unreadable) counts in NO session metric, so cookie loss reads as
 * abandon + unattributed simultaneously — read those two together before
 * concluding users never came back.
 *
 * unattributedCompletions exists as the cookie-failure signal: completions
 * with a NULL/unknown session (ctx cookie not sent, unreadable store, or
 * the click row itself lost). If that number grows while the rate sits at
 * 0%, the correlation pipeline is broken — a bug, not product friction —
 * and the panel makes it visible instead of failing silently as a
 * plausible-looking "0.0%".
 *
 * No retention by design (accepted debt, same standing decision as
 * watch_events): one row per click/login — tiny versus the searches
 * tables. If it ever dominates the page cost, aggregate in SQL with a
 * time window instead of scanning, or add a purge lane.
 */
export const getLoginFunnelStats = async (): Promise<LoginFunnelStats> => {
  const db = await getClient();
  const result = await withSchemaHint(
    db.execute({
      sql: `SELECT
              COALESCE(SUM(CASE WHEN event = 'login_cta_clicked' THEN 1 ELSE 0 END), 0) AS cta_events,
              COUNT(DISTINCT CASE WHEN event = 'login_cta_clicked' THEN session_id END) AS cta_sessions,
              COUNT(DISTINCT CASE WHEN event = 'login_callback_hit' THEN session_id END) AS callback_sessions,
              COUNT(DISTINCT CASE
                WHEN event = 'login_cta_clicked'
                  AND session_id NOT IN (
                    SELECT session_id FROM login_funnel_events
                    WHERE event = 'login_callback_hit' AND session_id IS NOT NULL
                  )
                  -- Pre-mid-step completions have no callback row (the
                  -- writer didn't exist yet): without this guard every
                  -- legacy login reads as "left at Steam".
                  AND session_id NOT IN (
                    SELECT session_id FROM login_funnel_events
                    WHERE event = 'login_completed' AND session_id IS NOT NULL
                  )
                THEN session_id
              END) AS steam_abandon_sessions,
              COUNT(DISTINCT CASE WHEN event = 'login_waiting_entered' THEN session_id END) AS waiting_sessions,
              COUNT(DISTINCT CASE
                WHEN event = 'login_waiting_entered'
                  AND session_id NOT IN (
                    SELECT session_id FROM login_funnel_events
                    WHERE event = 'login_completed' AND session_id IS NOT NULL
                  )
                THEN session_id
              END) AS waiting_leak_sessions,
              COALESCE(SUM(CASE WHEN event = 'login_completed' THEN 1 ELSE 0 END), 0) AS completions,
              COUNT(DISTINCT CASE
                WHEN event = 'login_completed'
                  AND session_id IN (
                    SELECT session_id FROM login_funnel_events
                    WHERE event = 'login_cta_clicked' AND session_id IS NOT NULL
                  )
                THEN session_id
              END) AS completed_sessions,
              COALESCE(SUM(CASE
                WHEN event = 'login_completed'
                  AND (session_id IS NULL OR session_id NOT IN (
                    SELECT session_id FROM login_funnel_events
                    WHERE event = 'login_cta_clicked' AND session_id IS NOT NULL
                  ))
                THEN 1 ELSE 0
              END), 0) AS unattributed_completions
            FROM login_funnel_events`,
    }),
  );

  // Empty table → SUMs are NULL (coalesced above) and COUNTs are 0; any
  // other impossible shape degrades to 0 rather than poisoning the panel.
  const toCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const row = (result.rows[0] ?? {}) as Record<string, unknown>;

  const ctaEvents = toCount(row.cta_events);
  const ctaSessions = toCount(row.cta_sessions);
  const callbackSessions = toCount(row.callback_sessions);
  const steamAbandonSessions = toCount(row.steam_abandon_sessions);
  const waitingSessions = toCount(row.waiting_sessions);
  const waitingLeakSessions = toCount(row.waiting_leak_sessions);
  const completions = toCount(row.completions);
  const completedSessions = toCount(row.completed_sessions);
  const unattributedCompletions = toCount(row.unattributed_completions);

  return {
    ctaEvents,
    ctaSessions,
    callbackSessions,
    steamAbandonSessions,
    waitingSessions,
    waitingLeakSessions,
    completions,
    completedSessions,
    unattributedCompletions,
    conversionRate:
      ctaSessions > 0 ? (completedSessions / ctaSessions) * 100 : null,
    popup: await readPopupStatsIsolated(db),
    generatedAt: new Date().toISOString(),
  };
};

// ---------------------------------------------------------------------------
// Promo-modal engagement (SponsorMe / SupportMe / login-prompt). One row
// per modal event; the dashboard reads raw per-modal counts (repeats
// included — "how many times", never a rate). Counts only by design: no
// session_id / search_id columns (see 018) — pure volume, no identifiers.
// Same best-effort contract as the funnel/popup tables: writers never
// throw into product code paths (routes catch), readers degrade (see
// readModalStatsIsolated below).
// ---------------------------------------------------------------------------

/** Row written by recordModalEvent (modal: app allowlist, event: 018 CHECK). */
export type ModalEventInput = {
  modal: ModalKind;
  event: ModalEventKind;
};

/**
 * Appends one modal event. Single INSERT (no batch — one row, nothing to
 * make atomic with). Throws on transport failure so routes can log loudly;
 * every caller treats it as non-fatal.
 */
export const recordModalEvent = async (
  input: ModalEventInput,
): Promise<void> => {
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO modal_events (modal, event, created_at)
            VALUES (?, ?, ?)`,
      args: [input.modal, input.event, new Date().toISOString()],
    }),
  );
};

/**
 * Read-only per-modal engagement aggregates for the analytics dashboard.
 * One GROUP BY query (at most 12 rows: 3 modals × 4 events), zero-filled
 * in JS so missing pairs read as 0, never undefined. Throws when the
 * table is missing (migration not run) — the dashboard route treats that
 * as fail-open null via readModalStatsIsolated below.
 */
export const getModalStats = async (): Promise<ModalDashboardStats> => {
  const db = await getClient();
  const result = await withSchemaHint(
    db.execute({
      sql: `SELECT modal, event, COUNT(*) AS n FROM modal_events GROUP BY modal, event`,
    }),
  );

  const toCount = (value: unknown): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : 0;
  const counts = new Map<string, number>();
  (result.rows as Array<Record<string, unknown>>).forEach((row) => {
    if (typeof row.modal === 'string' && typeof row.event === 'string') {
      counts.set(`${row.modal}:${row.event}`, toCount(row.n));
    }
  });

  const modalStats = (modal: ModalKind): ModalStats => ({
    shown: counts.get(`${modal}:shown`) ?? 0,
    ctaClicks: counts.get(`${modal}:cta_clicked`) ?? 0,
    closed: counts.get(`${modal}:closed`) ?? 0,
    dismissed: counts.get(`${modal}:dismissed`) ?? 0,
  });

  return {
    sponsor: modalStats('sponsor'),
    support: modalStats('support'),
    loginPrompt: modalStats('login_prompt'),
    generatedAt: new Date().toISOString(),
  };
};

/**
 * Modals read isolated from the funnel read. Same rollout rationale as
 * readPopupStatsIsolated: a DB with 018 pending must degrade ONLY the
 * modal sections to zeros, never null out the whole dashboard. Only a
 * missing TABLE is swallowed here (deliberately narrower than the shared
 * SCHEMA_MISSING_PATTERN, which also matches "no such column": a typo'd
 * column must surface as an unavailable section via the route's fail-open
 * null, never as plausible-looking zeros). Transport/logic errors still
 * throw for the same reason.
 */
const MODAL_TABLE_MISSING_PATTERN = /no such table/i;

export const readModalStatsIsolated = async (): Promise<ModalDashboardStats> => {
  try {
    return await getModalStats();
  } catch (error) {
    if (
      error instanceof Error &&
      MODAL_TABLE_MISSING_PATTERN.test(error.message)
    ) {
      const zeros: ModalStats = {
        shown: 0,
        ctaClicks: 0,
        closed: 0,
        dismissed: 0,
      };
      return {
        sponsor: { ...zeros },
        support: { ...zeros },
        loginPrompt: { ...zeros },
        generatedAt: new Date().toISOString(),
      };
    }
    throw error;
  }
};

/**
 * Arms (or re-arms) the confirmation token. Returns false when no account
 * row exists — callers create it first. Overwrites any previous pending
 * token, so at most one is ever outstanding (old links die on re-issue).
 * Never touches an already-confirmed account (confirmed_at IS NULL):
 * re-issuing over a confirmation would silently un-verify the user, so a
 * caller bug surfaces as a false return instead of clobbered state.
 */
export const issueConfirmToken = async (
  steamId: string,
  tokenHash: string,
  expiresAt: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertConfirmTokenHash(tokenHash);
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE accounts
            SET confirm_token_hash = ?, confirm_expires_at = ?
            WHERE steam_id = ?
              AND confirmed_at IS NULL`,
      args: [tokenHash, expiresAt, steamId],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

/**
 * First-contact-only variant of issueConfirmToken: arms the token ONLY
 * when no generation is outstanding (`confirm_token_hash IS NULL`, same
 * statement — no read-then-write window). Used by the reconcile link
 * lane (sendConfirmLink), which races the resend lane: both run in the
 * same bot process (onConnected fires the resend poller while reconcile
 * snapshot passes converge), and the resend lane issues unconditionally
 * (explicit user request, overwrite semantics). Without the guard, two
 * overlapping passes could each issue and each deliver — two chat
 * messages, first link dead on arrival. With it, the explicit request
 * deterministically wins: a resend issue landing first makes this a
 * 0-row no-op (caller skips quietly, the resend owns delivery); this
 * lane winning still lets the resend overwrite after (one stale extra
 * message at worst — newest link always live, never a lockout).
 * Returns false when a generation already exists or the account
 * confirmed concurrently.
 */
export const issueConfirmTokenIfAbsent = async (
  steamId: string,
  tokenHash: string,
  expiresAt: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertConfirmTokenHash(tokenHash);
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE accounts
            SET confirm_token_hash = ?, confirm_expires_at = ?
            WHERE steam_id = ?
              AND confirmed_at IS NULL
              AND confirm_token_hash IS NULL`,
      args: [tokenHash, expiresAt, steamId],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

/**
 * Rolls back an issued-but-UNDELIVERED confirm token (compare-and-delete):
 * clears hash + expiry ONLY while the row still carries exactly this
 * token hash on a still-unconfirmed account — a concurrent click that
 * consumed the token, or a resend generation that replaced it, can never
 * be clobbered. Returns true when the rollback actually cleared; false
 * when the hash no longer matches (a newer state won the race — not an
 * error, the caller rethrows its original send failure either way).
 *
 * Exists for the bot's confirm-link send path (activationMessage.ts):
 * issueConfirmToken commits BEFORE the chat send, so a Steam failure
 * after a successful issue would otherwise strand the account — the
 * site's confirmLinkSent derives from hash presence (UI: "check your
 * Steam chat"), and every later reconcile pass skips on first-issue-only,
 * so nothing but the 24h expiry would ever recover the user. Rolling the
 * issuance back returns the account to "never issued", which the next
 * reconcile pass (≤10 min) re-issues and re-delivers.
 */
export const clearConfirmToken = async (
  steamId: string,
  tokenHash: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertConfirmTokenHash(tokenHash);
  const db = await getClient();

  const cleared = await withSchemaHint(
    db.execute({
      sql: `UPDATE accounts
            SET confirm_token_hash = NULL, confirm_expires_at = NULL
            WHERE steam_id = ?
              AND confirm_token_hash = ?
              AND confirmed_at IS NULL`,
      args: [steamId, tokenHash],
    }),
  );
  return Number(cleared.rowsAffected) > 0;
};

/**
 * Atomically consumes a confirmation token: flips the account to confirmed
 * and clears the token columns in ONE UPDATE...RETURNING, so two concurrent
 * clicks (double-submit, retry, replay) converge on exactly one winner —
 * the loser sees zero rows and resolves to null instead of re-confirming.
 * Expired tokens and already-confirmed accounts never match the predicate.
 *
 * Returns the confirmed steamId, or null when nothing was consumed.
 */
export const consumeConfirmToken = async (
  tokenHash: string,
): Promise<string | null> => {
  assertConfirmTokenHash(tokenHash);
  const db = await getClient();
  const now = new Date().toISOString();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE accounts
            SET confirmed_at = ?, confirm_token_hash = NULL, confirm_expires_at = NULL
            WHERE confirm_token_hash = ?
              AND confirmed_at IS NULL
              AND confirm_expires_at IS NOT NULL
              AND confirm_expires_at > ?
            RETURNING steam_id`,
      args: [now, tokenHash, now],
    }),
  );
  if (updated.rows.length === 0) return null;
  return String((updated.rows[0] as Record<string, unknown>).steam_id);
};

/**
 * Non-consuming account lookup by pending-token hash (confirm page GET).
 * Lets the intermediate page render in the requester's language and flag
 * expired links WITHOUT spending the single-use token — prefetchers,
 * linkifiers and antivirus scanners only ever GET, so the token survives
 * until the explicit POST click. Returns null for unknown hashes
 * (indistinguishable from valid on GET by design — no oracle).
 */
export const getAccountByConfirmTokenHash = async (
  tokenHash: string,
): Promise<WatchAccount | null> => {
  assertConfirmTokenHash(tokenHash);
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT steam_id, created_at, confirmed_at, confirm_token_hash, confirm_expires_at, locale
            FROM accounts WHERE confirm_token_hash = ?`,
      args: [tokenHash],
    }),
  );
  if (row.rows.length === 0) return null;
  return toWatchAccount(row.rows[0] as Record<string, unknown>);
};

/**
 * Expired-but-never-clicked confirmations needing the single "link
 * expired, generate a new one" notice (confirm-link expiry poller input).
 * One row per account, oldest expiry first:
 * - unconfirmed, with a token whose expiry already passed;
 * - never noticed for THIS generation (`confirm_expire_noticed_for` is
 *   NULL or holds an older expiry — re-issuing always sets a fresh
 *   expiry, so a new generation implicitly re-arms the notice with no
 *   extra clearing write);
 * - watch still pending (active watches are confirmed by construction
 *   under click-to-activate; legacy actives never had tokens at all).
 *
 * Callers MUST re-check the account immediately before sending (a click
 * can land between this read and the chat send — the "only if really not
 * clicked" guarantee lives in that recheck plus the conditional
 * markExpireNoticed below, not in this listing). `limit` mirrors
 * claimNextQueuedEvents: default 10, clamped to 1..100, non-finite throws.
 */
export const listExpiredUnnoticedConfirms = async (
  limit = 10,
): Promise<ExpiredConfirmCandidate[]> => {
  if (!Number.isFinite(limit)) {
    throw new Error(
      'Invalid limit for expired-confirm scan: expected a finite number',
    );
  }
  const count = Math.min(Math.max(Math.floor(limit), 1), 100);
  const db = await getClient();
  const now = new Date().toISOString();

  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT w.steam_id AS steam_id,
              w.locale AS watch_locale,
              a.locale AS account_locale,
              a.confirm_expires_at AS expires_at
            FROM accounts a
            JOIN watched_profiles w ON w.steam_id = a.steam_id
            WHERE a.confirmed_at IS NULL
              AND a.confirm_expires_at IS NOT NULL
              AND a.confirm_expires_at <= ?
              AND (
                a.confirm_expire_noticed_for IS NULL
                OR a.confirm_expire_noticed_for != a.confirm_expires_at
              )
              AND w.status = 'pending'
            ORDER BY a.confirm_expires_at ASC
            LIMIT ?`,
      args: [now, count],
    }),
  );
  return rows.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      steamId: String(record.steam_id),
      watchLocale:
        typeof record.watch_locale === 'string' ? record.watch_locale : null,
      accountLocale:
        typeof record.account_locale === 'string'
          ? record.account_locale
          : null,
      expiresAt: String(record.expires_at),
    };
  });
};

/**
 * Records that the expiry notice was sent for one token generation.
 * Conditional write (the other half of "only if really not clicked"): a
 * concurrent confirm-click clears the token columns first, so the
 * predicate misses, zero rows change, and the false return tells the
 * poller the user clicked mid-flight (log it, send nothing more — the
 * confirm route owns activation + welcome from there).
 */
export const markExpireNoticed = async (
  steamId: string,
  expiresAt: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  if (typeof expiresAt !== 'string' || expiresAt === '') {
    throw new Error(
      'Invalid expiresAt for expire notice: expected non-empty string',
    );
  }
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE accounts
            SET confirm_expire_noticed_for = ?
            WHERE steam_id = ?
              AND confirmed_at IS NULL
              AND confirm_expires_at = ?`,
      args: [expiresAt, steamId, expiresAt],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

/**
 * Whether an invite event is currently open (queued or claimed) for this
 * profile. Used by the WB-6 compensation path (never roll back a row
 * someone else just queued an invite for). The predicate is shared with
 * enqueueEvent (OPEN_INVITE_PREDICATE_SQL) — a single constant, not two
 * WHERE clauses to keep in sync.
 */
export const hasOpenInviteEvent = async (steamId: string): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT 1 FROM watch_events
            WHERE steam_id = ? AND ${OPEN_INVITE_PREDICATE_SQL}
            LIMIT 1`,
      args: [steamId],
    }),
  );
  return row.rows.length > 0;
};

export const ANTI_LOOP_TOKEN_BYTES = 32;
export const ANTI_LOOP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const assertAntiLoopTokenHash = (tokenHash: string): void => {
  assertTokenHash(tokenHash, 'anti-loop token hash');
};

export const hashAntiLoopToken = (token: string): string =>
  sha256Hex(token);

/**
 * Issues an anti-loop token for a watched profile. Returns false if no
 * watched profile exists (callers should create it first). Overwrites any
 * previous pending token, so at most one is ever outstanding.
 * Tokens expire after ANTI_LOOP_TOKEN_TTL_MS.
 */
export const issueAntiLoopToken = async (
  steamId: string,
  tokenHash: string,
  expiresAt: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertAntiLoopTokenHash(tokenHash);
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET anti_loop_token_hash = ?, anti_loop_expires_at = ?
            WHERE steam_id = ?`,
      args: [tokenHash, expiresAt, steamId],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

/**
 * Atomically consumes an anti-loop token: clears the token columns in
 * ONE UPDATE...RETURNING, so two concurrent requests (double-click, retry)
 * converge on exactly one winner — the loser sees zero rows and resolves
 * to false instead of double-consuming.
 * Expired tokens never match the predicate.
 *
 * Single-use caveat: anything that fetches the link before the real click
 * (chat preview prefetch, browser/overlay preloading) consumes the token
 * early — the later real click then records normally (fail closed to a
 * plain search, never an error). Not a security issue, just the cost of
 * single-use links.
 *
 * Returns true if a token was consumed, false otherwise.
 */
export const consumeAntiLoopToken = async (
  steamId: string,
  tokenHash: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertAntiLoopTokenHash(tokenHash);
  const db = await getClient();
  const now = new Date().toISOString();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET anti_loop_token_hash = NULL, anti_loop_expires_at = NULL
            WHERE steam_id = ?
              AND anti_loop_token_hash = ?
              AND anti_loop_expires_at IS NOT NULL
              AND anti_loop_expires_at > ?
            RETURNING steam_id`,
      args: [steamId, tokenHash, now],
    }),
  );
  return updated.rows.length > 0;
};

/**
 * Atomic mint-if-absent variant of issueAntiLoopToken: arms the token ONLY
 * when no LIVE one is outstanding (same predicate the consume path
 * enforces — hash present and unexpired — in the SAME statement, so there
 * is no read-then-write window for a concurrent issuer to slip through).
 * Callers that must NOT invalidate someone else's outstanding link (the
 * inbox vs the bot's Steam-chat link share this one slot) use this, never
 * the blind overwrite: a lost race resolves to false (hands off, plain
 * links) instead of silently killing the other link. Returns false also
 * when no watch row exists.
 */
export const issueAntiLoopTokenIfAbsent = async (
  steamId: string,
  tokenHash: string,
  expiresAt: string,
): Promise<boolean> => {
  assertSteamId64(steamId);
  assertAntiLoopTokenHash(tokenHash);
  const db = await getClient();
  const now = new Date().toISOString();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET anti_loop_token_hash = ?, anti_loop_expires_at = ?
            WHERE steam_id = ?
              AND (
                anti_loop_token_hash IS NULL
                OR anti_loop_expires_at IS NULL
                OR anti_loop_expires_at <= ?
              )`,
      args: [tokenHash, expiresAt, steamId, now],
    }),
  );
  return Number(updated.rowsAffected) > 0;
};

export const countInvitesSentSince = async (
  sinceIso: string,
): Promise<number> => {
  if (!Number.isFinite(Date.parse(sinceIso))) {
    throw new Error(
      `Invalid since timestamp for invite count: expected ISO-8601 (got ${JSON.stringify(sinceIso)})`,
    );
  }
  const db = await getClient();

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT COUNT(*) AS n FROM watch_events
            WHERE kind = 'invite' AND sent_at IS NOT NULL AND sent_at >= ?`,
      args: [sinceIso],
    }),
  );
  const count = Number(row.rows[0]?.n ?? 0);
  return Number.isFinite(count) ? count : 0;
};

/**
 * Restarts the invite-request clock (requested_at = now) for a pending
 * watch. Optionally refreshes the locale at the same time: a provided
 * valid locale overwrites, an absent/invalid one keeps the stored value
 * (COALESCE) — re-requesting from a new browser language updates the bot's
 * message language without a separate call.
 */
export const refreshWatchRequest = async (
  steamId: string,
  locale?: string | null,
): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const refreshed = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles SET requested_at = ?, locale = COALESCE(?, locale)
            WHERE steam_id = ? AND status = 'pending'`,
      args: [new Date().toISOString(), normalizeLocale(locale), steamId],
    }),
  );
  return Number(refreshed.rowsAffected) > 0;
};

/**
 * Records one failed delivery attempt for a worker-claimed event and
 * routes it: back to 'queued' for another short retry, or to 'dropped'
 * once attempts reach maxAttempts. Returns null when the row is not
 * claimed (already settled or missing) — the poller treats that as
 * "someone else handled it" and moves on.
 *
 * Single UPDATE...RETURNING statement (no read-then-write): the atomic
 * claim already guarantees single ownership, and one statement means never
 * reasoning about interleavings at all.
 */
export const recordEventAttempt = async (
  id: number,
  maxAttempts: number,
): Promise<'requeued' | 'dropped' | null> => {
  if (!Number.isFinite(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      'Invalid maxAttempts for watch event retry: expected positive integer',
    );
  }
  const db = await getClient();
  const cap = Math.floor(maxAttempts);
  const now = new Date().toISOString();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watch_events
            SET attempts = attempts + 1,
                status = CASE WHEN attempts + 1 >= ? THEN 'dropped' ELSE 'queued' END,
                claimed_at = CASE WHEN attempts + 1 >= ? THEN claimed_at ELSE NULL END,
                sent_at = CASE WHEN attempts + 1 >= ? THEN ? ELSE sent_at END
            WHERE id = ? AND status = 'claimed'
            RETURNING status`,
      args: [cap, cap, cap, now, id],
    }),
  );
  if (updated.rows.length === 0) return null;
  return updated.rows[0].status === 'dropped' ? 'dropped' : 'requeued';
};

// ---------------------------------------------------------------------------
// Ban Reveal Phase 1 — targets, subscriptions, fan-out, reveals.
// Opposite direction from watched_profiles (see types.ts): the SUBSCRIBER
// is the logged-in user who opened the cheater report, the TARGET is the
// reviewed profile. Every steamId input asserts SteamID64; every state
// transition below is a single atomic statement (never read-then-write).
// Phase 1 only ever reads/writes source = 'steam' — the column exists so
// a future FACEIT/Gamersclub sweep reuses the PK without a migration.
// ---------------------------------------------------------------------------

// Always bound as a `?` arg, never interpolated into SQL — the value is
// fixed today, but the file's parametrized convention must survive the day
// it becomes dynamic.
const BAN_WATCH_SOURCE = 'steam';

const toBanWatchTarget = (row: Record<string, unknown>): BanWatchTarget => ({
  targetSteamId: String(row.target_steam_id),
  source: 'steam',
  lastKnownBanned: Number(row.last_known_banned ?? 0) === 1,
  lastBanCheckedAt:
    typeof row.last_ban_checked_at === 'string'
      ? row.last_ban_checked_at
      : null,
});

const toBanWatchSubscription = (
  row: Record<string, unknown>,
): BanWatchSubscription => ({
  id: Number(row.id),
  subscriberSteamId: String(row.subscriber_steam_id),
  targetSteamId: String(row.target_steam_id),
  searchId: typeof row.search_id === 'string' ? row.search_id : null,
  subscribedAt: String(row.subscribed_at),
  notifiedAt: typeof row.notified_at === 'string' ? row.notified_at : null,
});

/**
 * Resolves the reviewed profile's SteamID64 from a recorded search id via
 * the trusted profiles join (same join pattern as listProfileSearches).
 * The cheater route only receives searchId from the client, so the target
 * MUST come from this join — never from client input (same
 * identity-from-session-or-trusted-join convention as the signup route
 * rejecting a client-supplied steamId). Returns null when the search (or
 * its profile row) does not exist.
 */
export const getSteamIdBySearchId = async (
  searchId: string,
): Promise<string | null> => {
  if (typeof searchId !== 'string' || searchId.length === 0) {
    throw new Error(
      'Invalid searchId for ban-watch lookup: expected non-empty string',
    );
  }
  const db = await getClient();
  const row = await withSchemaHint(
    db.execute({
      sql: 'SELECT steam_id FROM profiles WHERE search_id = ?',
      args: [searchId],
    }),
  );
  if (row.rows.length === 0) return null;
  const steamId = (row.rows[0] as Record<string, unknown>).steam_id;
  return typeof steamId === 'string' && steamId.length > 0 ? steamId : null;
};

/**
 * Ensures the sweep tracks this target (one row per distinct profile).
 * Idempotent INSERT ... ON CONFLICT DO NOTHING — re-opening the cheater
 * report for an already-tracked profile is a no-op here, same idiom as
 * createWatchRequest / createAccount.
 */
export const ensureBanTarget = async (targetSteamId: string): Promise<void> => {
  assertSteamId64(targetSteamId);
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO ban_watch_targets
            (target_steam_id, source, last_known_banned, last_ban_checked_at)
            VALUES (?, ?, 0, NULL)
            ON CONFLICT(target_steam_id, source) DO NOTHING`,
      args: [targetSteamId, BAN_WATCH_SOURCE],
    }),
  );
};

/**
 * Reads one sweep target (Phase 1: source = 'steam' only). Null when the
 * sweep has never seen this profile — the subscribe path treats that as
 * "unchecked" (live single-ID ban check or fail-open, never an alert).
 */
export const getBanTarget = async (
  targetSteamId: string,
): Promise<BanWatchTarget | null> => {
  assertSteamId64(targetSteamId);
  const db = await getClient();
  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT target_steam_id, source, last_known_banned, last_ban_checked_at
            FROM ban_watch_targets
            WHERE target_steam_id = ? AND source = ?`,
      args: [targetSteamId, BAN_WATCH_SOURCE],
    }),
  );
  if (row.rows.length === 0) return null;
  return toBanWatchTarget(row.rows[0] as Record<string, unknown>);
};

export interface CreateBanSubscriptionResult {
  subscription: BanWatchSubscription;
  /** False when the row already existed (re-opened report: no-op insert). */
  created: boolean;
}

/**
 * Creates a ban-watch subscription. Idempotent: at most one row per
 * (subscriber, target) — re-opening the cheater report for an already
 * subscribed profile is a no-op insert (ON CONFLICT DO NOTHING + SELECT,
 * same idiom as createWatchRequest). When alreadyBanned is true (target
 * was already banned at subscribe time — a pre-existing ban, not a new
 * detection), notified_at is set immediately so the sweep can never fire
 * an alert for it.
 */
export const createBanSubscription = async (
  subscriberSteamId: string,
  targetSteamId: string,
  searchId: string | null,
  alreadyBanned: boolean,
): Promise<CreateBanSubscriptionResult> => {
  assertSteamId64(subscriberSteamId);
  assertSteamId64(targetSteamId);
  if (searchId !== null && (typeof searchId !== 'string' || searchId === '')) {
    throw new Error(
      'Invalid searchId for ban-watch subscription: expected non-empty string or null',
    );
  }
  const db = await getClient();
  const now = new Date().toISOString();

  const inserted = await withSchemaHint(
    db.execute({
      sql: `INSERT INTO ban_watch_subscriptions
            (subscriber_steam_id, target_steam_id, search_id, subscribed_at, notified_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(subscriber_steam_id, target_steam_id) DO NOTHING`,
      args: [
        subscriberSteamId,
        targetSteamId,
        searchId,
        now,
        alreadyBanned ? now : null,
      ],
    }),
  );
  const created = Number(inserted.rowsAffected) > 0;

  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT id, subscriber_steam_id, target_steam_id, search_id, subscribed_at, notified_at
            FROM ban_watch_subscriptions
            WHERE subscriber_steam_id = ? AND target_steam_id = ?`,
      args: [subscriberSteamId, targetSteamId],
    }),
  );
  // Unreachable unless the row was deleted between the two statements (no
  // production path deletes subscriptions in Phase 1 — no unsubscribe UI).
  // Throw rather than fabricate a row.
  if (row.rows.length === 0) {
    throw new Error(
      'createBanSubscription lost a concurrent race unexpectedly',
    );
  }
  return {
    subscription: toBanWatchSubscription(row.rows[0] as Record<string, unknown>),
    created,
  };
};

/**
 * Sweep input: distinct Steam targets to check this pass, oldest-sighting
 * first (NULL sightings — never checked — sort first so new targets
 * converge within one interval). One slot per DISTINCT target regardless
 * of subscriber count — a popular target with many subscribers still
 * costs exactly one GetPlayerBans id. `limit` mirrors
 * claimNextQueuedEvents: default 100 (= one GetPlayerBans call), clamped
 * to 1..100, non-finite throws.
 */
export const listDistinctBanTargets = async (
  limit = 100,
): Promise<string[]> => {
  if (!Number.isFinite(limit)) {
    throw new Error(
      'Invalid limit for ban-target scan: expected a finite number',
    );
  }
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const db = await getClient();
  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT target_steam_id FROM ban_watch_targets
            WHERE source = ?
            ORDER BY last_ban_checked_at ASC NULLS FIRST, target_steam_id ASC
            LIMIT ?`,
      args: [BAN_WATCH_SOURCE, n],
    }),
  );
  return rows.rows.map((row) =>
    String((row as Record<string, unknown>).target_steam_id),
  );
};

/**
 * Records a sweep sighting. A true->false transition (unban / data
 * correction) flips the flag ONLY — notified_at on every subscription is
 * deliberately left untouched (no re-alert on a flapping ban status
 * without an explicit product decision to allow it).
 */
export const markBanTargetChecked = async (
  targetSteamId: string,
  banned: boolean,
): Promise<void> => {
  assertSteamId64(targetSteamId);
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `UPDATE ban_watch_targets
            SET last_known_banned = ?, last_ban_checked_at = ?
            WHERE target_steam_id = ? AND source = ?`,
      args: [banned ? 1 : 0, new Date().toISOString(), targetSteamId, BAN_WATCH_SOURCE],
    }),
  );
};

/**
 * Fan-out input: every subscription on this target that has never been
 * notified (notified_at IS NULL). Ordered by id (oldest subscriber
 * first) so delivery order is deterministic per target.
 */
export const listUnnotifiedBanSubscriptions = async (
  targetSteamId: string,
): Promise<BanWatchSubscription[]> => {
  assertSteamId64(targetSteamId);
  const db = await getClient();
  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT id, subscriber_steam_id, target_steam_id, search_id, subscribed_at, notified_at
            FROM ban_watch_subscriptions
            WHERE target_steam_id = ? AND notified_at IS NULL
            ORDER BY id ASC`,
      args: [targetSteamId],
    }),
  );
  return rows.rows.map((row) =>
    toBanWatchSubscription(row as Record<string, unknown>),
  );
};

export interface EnqueueBanAlertResult {
  /** The outbox event id (null only when the rowid was unrecoverable). */
  eventId: number | null;
  /** False when another worker already notified this subscription. */
  enqueued: boolean;
}

/**
 * Fans out ONE alert: enqueues the ban_alert outbox event AND gates the
 * subscription (notified_at) in the SAME db.batch — the same-transaction
 * pattern as markEventSent + its cooldown clock. The predicate carries
 * `notified_at IS NULL` so the caller can tell a lost race apart (the
 * loser sees zero rows on the UPDATE and reports enqueued:false instead
 * of counting a phantom alert).
 *
 * The event carries search_id = NULL deliberately: watch_events.search_id
 * is UNIQUE (one message per search), and the originating search may
 * already own a 'notify' event — reusing it here would collide. Ban
 * alerts are per-subscription, not per-search.
 */
export const enqueueBanAlertForSubscription = async (
  subscriptionId: number,
  subscriberSteamId: string,
): Promise<EnqueueBanAlertResult> => {
  assertSteamId64(subscriberSteamId);
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    throw new Error(
      'Invalid subscription id for ban alert: expected positive integer',
    );
  }
  const db = await getClient();
  const now = new Date().toISOString();

  const results = await withSchemaHint(
    db.batch([
      {
        sql: `INSERT INTO watch_events
              (search_id, steam_id, kind, status, created_at, claimed_at, sent_at)
              VALUES (NULL, ?, 'ban_alert', 'queued', ?, NULL, NULL)`,
        args: [subscriberSteamId, now],
      },
      {
        sql: `UPDATE ban_watch_subscriptions
              SET notified_at = ?
              WHERE id = ? AND notified_at IS NULL`,
        args: [now, subscriptionId],
      },
    ]),
  );
  // The UPDATE is the gate: zero rows means another worker already
  // notified this subscription (or the row vanished) — enqueued:false so
  // the sweep never double-counts. Honest residual, stated plainly: the
  // INSERT above still committed, and the ban-alert poller's recipient
  // check is subscriber-scoped (any subscription row), NOT per-target —
  // the event carries no target/subscription id — so that orphan WOULD be
  // delivered as one generic duplicate, not dropped. That race needs two
  // overlapping sweep workers, which this deployment cannot produce
  // (single bot process + the sweeper's overlap guard + a 6h interval);
  // the second-bot shard (ACQ_BOT_* namespace) must close it first, e.g.
  // with a per-subscription UNIQUE event key. A duplicate is generic copy
  // with no profile in it, so the blast radius is one redundant ping.
  const gated = Number(results?.[1]?.rowsAffected) > 0;
  if (!gated) return { eventId: null, enqueued: false };
  const eventId = Number(results?.[0]?.lastInsertRowid ?? NaN);
  return {
    eventId: Number.isFinite(eventId) ? eventId : null,
    enqueued: true,
  };
};

/**
 * Reads one subscription for the reveal-click auth check (must be the
 * subscribing user for that row — no other gating in Phase 1). Null when
 * no such subscription exists.
 */
export const getBanSubscription = async (
  subscriberSteamId: string,
  targetSteamId: string,
): Promise<BanWatchSubscription | null> => {
  assertSteamId64(subscriberSteamId);
  assertSteamId64(targetSteamId);
  const db = await getClient();
  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT id, subscriber_steam_id, target_steam_id, search_id, subscribed_at, notified_at
            FROM ban_watch_subscriptions
            WHERE subscriber_steam_id = ? AND target_steam_id = ?`,
      args: [subscriberSteamId, targetSteamId],
    }),
  );
  if (row.rows.length === 0) return null;
  return toBanWatchSubscription(row.rows[0] as Record<string, unknown>);
};

/**
 * Reads one subscription by id (inbox reveal handle). The caller MUST
 * verify subscription.subscriberSteamId equals the session steamId before
 * disclosing anything — the id alone is not an auth proof.
 */
export const getBanSubscriptionById = async (
  subscriptionId: number,
): Promise<BanWatchSubscription | null> => {
  if (!Number.isInteger(subscriptionId) || subscriptionId <= 0) {
    throw new Error(
      'Invalid subscription id for ban lookup: expected positive integer',
    );
  }
  const db = await getClient();
  const row = await withSchemaHint(
    db.execute({
      sql: `SELECT id, subscriber_steam_id, target_steam_id, search_id, subscribed_at, notified_at
            FROM ban_watch_subscriptions WHERE id = ?`,
      args: [subscriptionId],
    }),
  );
  if (row.rows.length === 0) return null;
  return toBanWatchSubscription(row.rows[0] as Record<string, unknown>);
};

/**
 * Ban-alert inbox stream: every NOTIFIED subscription for this subscriber
 * (notified_at IS NOT NULL), newest alert first. This is the web-visibility
 * guarantee — it reads subscriptions, NOT outbox delivery state, so a chat
 * send dropped for a non-friend subscriber still surfaces here (chat
 * delivery and inbox visibility are deliberately not the same guarantee).
 * The payload is generic by design: no target steamId until the reveal
 * click (see getBanSubscriptionById + recordBanRevealClick).
 */
export const listBanAlertsForSubscriber = async (
  subscriberSteamId: string,
  limit = 50,
): Promise<BanAlertNotification[]> => {
  assertSteamId64(subscriberSteamId);
  if (!Number.isFinite(limit)) {
    throw new Error('Invalid limit for ban alerts: expected a finite number');
  }
  const n = Math.max(1, Math.min(100, Math.floor(limit)));
  const db = await getClient();
  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT id, subscribed_at, notified_at
            FROM ban_watch_subscriptions
            WHERE subscriber_steam_id = ? AND notified_at IS NOT NULL
            ORDER BY notified_at DESC, id DESC LIMIT ?`,
      args: [subscriberSteamId, n],
    }),
  );
  return rows.rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      id: Number(record.id),
      subscribedAt: String(record.subscribed_at),
      notifiedAt: String(record.notified_at),
    };
  });
};

/**
 * Logs a reveal-click event (subscriber, target, timestamp — server-side
 * only). Append-only instrumentation for a future monetization decision,
 * not a gate: the reveal itself is authorized by getBanSubscription* above.
 */
export const recordBanRevealClick = async (
  subscriberSteamId: string,
  targetSteamId: string,
): Promise<void> => {
  assertSteamId64(subscriberSteamId);
  assertSteamId64(targetSteamId);
  const db = await getClient();
  await withSchemaHint(
    db.execute({
      sql: `INSERT INTO ban_watch_reveals
            (subscriber_steam_id, target_steam_id, clicked_at)
            VALUES (?, ?, ?)`,
      args: [subscriberSteamId, targetSteamId, new Date().toISOString()],
    }),
  );
};

/**
 * Ban-alert poller recipient check: does this subscriber still hold ANY
 * ban-watch subscription, and in which language should the chat ping go?
 * Null when no subscription row exists (deleted by a future admin action
 * — the only Phase-1 path to zero rows, since there is no unsubscribe UI).
 * Locale follows the watch rule (watch row first, account fallback,
 * English past both) so the chat ping matches the subscriber's other bot
 * messages.
 *
 * Wiring note: the bot (index.ts) binds this as the poller's
 * `getBanSubscriptionForAlert` — the poller-lane name for this same
 * subscriber-scoped check. Deliberately subscriber-scoped, not
 * per-subscription: the ban_alert outbox row carries no target or
 * subscription id (see enqueueBanAlertForSubscription), so a finer check
 * is not expressible without a schema change.
 */
export const getBanSubscriberState = async (
  subscriberSteamId: string,
): Promise<{ locale: string | null } | null> => {
  assertSteamId64(subscriberSteamId);
  const db = await getClient();
  const subs = await withSchemaHint(
    db.execute({
      sql: `SELECT 1 FROM ban_watch_subscriptions
            WHERE subscriber_steam_id = ? LIMIT 1`,
      args: [subscriberSteamId],
    }),
  );
  if (subs.rows.length === 0) return null;
  const locales = await withSchemaHint(
    db.batch([
      {
        sql: 'SELECT locale FROM watched_profiles WHERE steam_id = ?',
        args: [subscriberSteamId],
      },
      {
        sql: 'SELECT locale FROM accounts WHERE steam_id = ?',
        args: [subscriberSteamId],
      },
    ]),
  );
  const watchLocale = locales?.[0]?.rows?.[0]?.locale;
  const accountLocale = locales?.[1]?.rows?.[0]?.locale;
  if (typeof watchLocale === 'string') return { locale: watchLocale };
  if (typeof accountLocale === 'string') return { locale: accountLocale };
  return { locale: null };
};

// ---------------------------------------------------------------------------
// getSearchRecords — the read path. Reconstructs the full SearchRecord[] that
// the old JSON datastore produced, so the dashboard template (and anything
// else consuming SearchRecord[]) works unchanged against Turso.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

const toNullableString = (value: unknown): string | null => {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return null;
  return String(value);
};

const toNullableNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  return null;
};

const parseLocationGuesses = (rows: Row[]): LocationGuess[] => {
  const guesses: LocationGuess[] = [];

  rows.forEach((row) => {
    try {
      guesses.push({
        location: JSON.parse(
          row.location as string,
        ) as LocationGuess['location'],
        probability: typeof row.probability === 'number' ? row.probability : 0,
      });
    } catch {
      // One corrupted/legacy row must not take the whole dashboard down —
      // skip just that guess.
    }
  });

  return guesses;
};

// Child rows indexed by search, shared by the two record readers below:
// identical indexing + mapping, so a coercion fix in one can't silently
// drift from the other. The ONLY deliberate difference is the games leg,
// which getDashboardHistory skips (no panel reads per-row games) — hence
// games maps to null there instead of omitting the field.
type SearchChildMaps = {
  friends: Map<string, FriendRecord[]>;
  locations: Map<string, LocationGuess[]>;
  cheaters: Map<string, CheaterProbabilityRecord>;
  games: Map<string, GameSnapshotEntry[]> | null;
};

const indexSearchChildren = (
  friendRows: Row[],
  locationRows: Row[],
  cheaterRows: Row[],
  gameRows: Row[] | null,
): SearchChildMaps => {
  const friends = new Map<string, FriendRecord[]>();
  friendRows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = friends.get(searchId) ?? [];
    list.push({
      steamId: row.steam_id as string,
      nickname: toNullableString(row.nickname),
      gcName: toNullableString(row.gc_name),
      mutualCount: toNullableNumber(row.mutual_count),
      probability: toNullableNumber(row.probability),
      countryCode: toNullableString(row.country_code),
    });
    friends.set(searchId, list);
  });

  const locations = new Map<string, LocationGuess[]>();
  locationRows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = locations.get(searchId) ?? [];
    list.push(...parseLocationGuesses([row]));
    locations.set(searchId, list);
  });

  const cheaters = new Map<string, CheaterProbabilityRecord>();
  cheaterRows.forEach((row) => {
    cheaters.set(row.search_id as string, {
      score: row.score as number,
      bannedFriendsCount: toNullableNumber(row.banned_friends_count),
      computedAt: row.computed_at as string,
    });
  });

  if (gameRows === null) {
    return { friends, locations, cheaters, games: null };
  }
  const games = new Map<string, GameSnapshotEntry[]>();
  gameRows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = games.get(searchId) ?? [];
    list.push({
      name: row.name as string,
      playtimeHours:
        typeof row.playtime_hours === 'number'
          ? row.playtime_hours
          : Number(row.playtime_hours ?? 0),
    });
    games.set(searchId, list);
  });
  return { friends, locations, cheaters, games };
};

const mapSearchRecord = (
  row: Row,
  children: SearchChildMaps,
): SearchRecord | null => {
  const searchId = row.id as string;

  // Defensive: the LEFT JOIN on profiles can only ever yield a NULL
  // steam_id if a searches row lost its profile (impossible through the
  // DAL — recordSearch writes both atomically — but hand-edited rows or a
  // partial legacy import could do it). A profile-less record renders a
  // broken dashboard row (null steamId), so drop it instead of casting the
  // null to string and shipping a corrupt SearchRecord.
  if (typeof row.steam_id !== 'string' || row.steam_id.length === 0) {
    return null;
  }

  const profile: ProfileRecord = {
    steamId: row.steam_id as string,
    steamUrl: toNullableString(row.steam_url),
    nickname: toNullableString(row.nickname),
    gcName: toNullableString(row.gc_name),
    countryCode: toNullableString(row.country_code),
    stateCode: toNullableString(row.state_code),
    cityId: toNullableString(row.city_id),
  };

  const { is_cs_active: isActive, device } = row;
  const cheater = children.cheaters.get(searchId) ?? null;

  return {
    id: searchId,
    searchedAt: row.searched_at as string,
    profile,
    friendsVisibility: normalizeFriendsVisibility(row.friends_visibility),
    // An empty child table reads back as arrays/nulls regardless of whether
    // the source sent `[]` or `undefined` (both store zero rows) — fine, the
    // dashboard treats null and [] the same (it maps over `?? []`).
    friends: children.friends.get(searchId) ?? [],
    gamesSnapshot: children.games?.get(searchId) ?? null,
    isCSActive:
      typeof isActive === 'number' && (isActive === 0 || isActive === 1)
        ? isActive === 1
        : null,
    requesterLocale: toNullableString(row.requester_locale),
    // Same choke point as listProfileSearches: legacy lowercase
    // rows read back canonical, so dashboard and inbox agree.
    requesterCountry: normalizeCountryCode(row.requester_country),
    requesterBrowserLanguage: toNullableString(
      row.requester_browser_language,
    ),
    device: (device === 'mobile' || device === 'desktop'
      ? device
      : null) as 'mobile' | 'desktop' | null,
    locationGuess: children.locations.get(searchId) ?? null,
    cheater,
    durationMs: toNullableNumber(row.duration_ms),
    searcherSteamId:
      typeof row.searcher_steam_id === 'string' &&
      isSteamId64(row.searcher_steam_id)
        ? (row.searcher_steam_id as string)
        : null,
  };
};

/**
 * "My searches" read side — full docblock lives directly above
 * listSearcherSearches below (JSDoc attaches to the next declaration,
 * so it cannot sit here above the cursor/limit helpers).
 */
// Single source of truth lives in ./historyLimits (client-safe, no
// server imports — the modal imports it directly instead of db.ts).
// NOTE: no re-export here on purpose — nothing imports these from the
// DAL, and a compat alias would suggest otherwise.

export interface SearcherHistoryCursor {
  searchedAt: string;
  searchId: string;
}

/**
 * Strict ISO-8601 UTC timestamp guard for history cursors. Date.parse
 * alone accepts anything ("next Tuesday") while the SQL comparison is
 * lexicographic — on mixed formats that silently mis-pages. searched_at
 * is always written by toISOString (Zulu), and cursors are only ever
 * server-built from it, so the pattern requires the Z suffix: offsets
 * have no legitimate producer and stay rejected. Shared by
 * parseHistoryCursor and the listSearcherSearches defensive
 * revalidation (never trust a cursor object built by hand).
 */
const HISTORY_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

const isHistoryTimestamp = (value: unknown): value is string =>
  typeof value === 'string' &&
  HISTORY_TIMESTAMP_PATTERN.test(value) &&
  Number.isFinite(Date.parse(value));

/**
 * Parses an opaque page cursor ("searchedAt|searchId", URL-encoded by the
 * client). Null in, null out (first page); garbage in, null out — the
 * ROUTE turns a provided-but-garbage cursor into a 400, the DAL treats
 * null as "from the top". Strict by construction: ids embed wall-clock
 * time plus randomness and are not ordered, so only the pair orders.
 */
export const parseHistoryCursor = (
  cursor: string | null | undefined,
): SearcherHistoryCursor | null => {
  if (cursor === null || cursor === undefined || cursor === '') return null;
  const separator = cursor.indexOf('|');
  if (separator <= 0 || separator === cursor.length - 1) return null;
  const searchedAt = cursor.slice(0, separator);
  const searchId = cursor.slice(separator + 1);
  // Search ids are `${Date.now()}-${6 base36 chars}` (~20 chars); cap
  // defensively so a hand-forged bookmark can't smuggle kilobytes into
  // a SQL arg (parameterized anyway — this is hygiene, not security).
  if (
    !isHistoryTimestamp(searchedAt) ||
    searchId.length === 0 ||
    searchId.length > 64
  ) {
    return null;
  }
  return { searchedAt, searchId };
};

export interface SearcherHistoryPage {
  entries: SearcherHistoryEntry[];
  /**
   * Server-built bookmark for the next page (null = exhausted). The
   * client passes it back opaquely — it never constructs the
   * "searchedAt|searchId" format itself, so the format lives in exactly
   * one place (parseHistoryCursor). Fetching n+1 rows also kills the
   * "eternal load-more" case: a page can no longer come back empty while
   * claiming more rows exist.
   */
  nextCursor: string | null;
  /**
   * All-time row total for the modal's "showing N of M" note — computed
   * ONLY on the first page (cursor === null) and null afterwards. A
   * COUNT(*) per "load more" is pure waste: the client already holds
   * the total from page one.
   */
  total: number | null;
}

/**
 * "My searches" read side: recorded searches RUN BY one viewer, newest
 * first. The mirror image of listProfileSearches (which answers "who
 * searched ME"): same shape discipline (newest-first, capped window,
 * cheater EXISTS flag), but keyed by searches.searcher_steam_id and
 * projecting the TARGET profile (what the viewer looked up) instead of
 * the searcher country. Profile-less rows (hand edits) are dropped like
 * mapSearchRecord drops them — a history row without a target renders
 * nothing. Rows predating the column (NULL searcher) never match.
 *
 * Keyset pagination (NOT limit-offset): `cursor` is an opaque
 * "searchedAt|searchId" bookmark; the next page continues strictly older
 * (searched_at, id) pairs. Offset would skip or duplicate rows when a
 * search lands mid-paging; keyset cannot. A limit-window cannot grow the
 * page (the old limit-only design returned the same N rows forever once
 * the clamp bit — load-more that never loads).
 */
export const listSearcherSearches = async (
  searcherSteamId: string,
  limit: number = HISTORY_PAGE_DEFAULT_LIMIT,
  cursor: SearcherHistoryCursor | null = null,
): Promise<SearcherHistoryPage> => {
  assertSteamId64(searcherSteamId);
  if (!Number.isFinite(limit)) {
    throw new Error('Invalid search limit: expected a finite number');
  }
  if (
    cursor !== null &&
    (!isHistoryTimestamp(cursor.searchedAt) ||
      typeof cursor.searchId !== 'string' ||
      cursor.searchId.length === 0 ||
      cursor.searchId.length > 64)
  ) {
    throw new Error('Invalid history cursor: expected a parsed cursor or null');
  }
  const n = Math.max(1, Math.min(HISTORY_PAGE_MAX_LIMIT, Math.floor(limit)));
  const db = await getClient();

  // Retention enforced AT READ, not just by the bot's daily purge: the
  // modal promises "links expire after 12 months", and the bot can be
  // down for weeks (crash-loop, deploy gap) while searches keep landing.
  // Rows older than the TTL are invisible here (and uncounted) whether
  // or not the physical purge has run yet — the purge then only reclaims
  // what reads already hide. searched_at is toISOString at write, so the
  // lexicographic comparison orders correctly.
  //
  // Index story (020): searcher_steam_id lives ON searches with the
  // composite partial index (searcher_steam_id, searched_at DESC,
  // id DESC) — so the filter AND the ORDER BY AND the keyset bound are
  // all served by one COVERING index seek (verified by EXPLAIN QUERY
  // PLAN on the real schema, Oct 2026: SEARCH s USING COVERING INDEX
  // idx_searches_searcher, no temp B-tree). Page cost is O(page), not
  // O(user history).
  const retentionCutoff = new Date(Date.now() - SEARCHER_LINK_TTL_MS).toISOString();

  const clauses = ['s.searcher_steam_id = ?', 's.searched_at >= ?'];
  const args: (string | number)[] = [searcherSteamId, retentionCutoff];
  if (cursor !== null) {
    clauses.push(
      '(s.searched_at < ? OR (s.searched_at = ? AND s.id < ?))',
    );
    args.push(cursor.searchedAt, cursor.searchedAt, cursor.searchId);
  }
  // n+1 probe: the extra row is never rendered — its presence alone
  // proves a next page exists (and supplies its bookmark).
  const pageArgs = [...args, n + 1];
  const statements: Array<{ sql: string; args: (string | number)[] }> = [
    {
      sql: `SELECT s.id AS search_id, s.searched_at,
              p.steam_id AS steam_id, p.nickname AS nickname,
              EXISTS (
                SELECT 1 FROM cheater_results c WHERE c.search_id = s.id
              ) AS cheater_checked
            FROM searches s
            JOIN profiles p ON p.search_id = s.id
            WHERE ${clauses.join(' AND ')}
              AND p.steam_id IS NOT NULL AND p.steam_id != ''
            ORDER BY s.searched_at DESC, s.id DESC LIMIT ?`,
      args: pageArgs,
    },
  ];
  // COUNT only on the first page (see SearcherHistoryPage.total): every
  // later page reuses the client's total, so the count query runs once
  // per modal open, not once per click. Same retention cutoff as the
  // page: the total counts the visible population, matching
  // "showing N of M". Range-count on the same composite index.
  if (cursor === null) {
    statements.push({
      sql: `SELECT COUNT(*) AS n FROM searches s
            JOIN profiles p ON p.search_id = s.id
            WHERE s.searcher_steam_id = ?
              AND s.searched_at >= ?
              AND p.steam_id IS NOT NULL AND p.steam_id != ''`,
      args: [searcherSteamId, retentionCutoff],
    });
  }
  const results = await withSchemaHint(db.batch(statements));

  const rows = results[0].rows as Array<Record<string, unknown>>;
  const hasMore = rows.length > n;
  const entries = rows.slice(0, n).map((record) => ({
    searchId: record.search_id as string,
    searchedAt: record.searched_at as string,
    steamId: record.steam_id as string,
    nickname: toNullableString(record.nickname),
    cheaterChecked: Number(record.cheater_checked ?? 0) > 0,
  }));
  const lastRendered = entries[entries.length - 1];
  const counted =
    cursor === null ? Number(results[1]?.rows[0]?.n ?? 0) : null;
  const total = counted === null || Number.isFinite(counted) ? counted : 0;
  return {
    entries,
    nextCursor:
      hasMore && lastRendered
        ? `${lastRendered.searchedAt}|${lastRendered.searchId}`
        : null,
    total,
  };
};

/**
 * @deprecated Dashboard no longer calls this: getDashboardStats() (all-time
 * aggregates) + getDashboardHistory() (capped window) replaced the
 * unbounded five-table read on the dashboard path. Kept for its tested
 * full-read contract (db.test.ts, db.integration.test.ts) and any future
 * offline/export use — do NOT point request handlers at it without a
 * LIMIT: friends/games/locations grow ~15/40/1 rows per search.
 *
 * Deliberate asymmetry: this keeps selecting m.searcher_steam_id (full-read
 * contract) while getDashboardHistory does NOT — the dashboard path stays
 * double-stripped (SQL + serializeEntries) so who-searched-whom can never
 * reach the page source. Do not "simplify" the two SELECTs into one.
 *
 * No 020-pending fallback here (unlike recordSearch): this has zero
 * production callers (tests + future offline/export only), so a
 * missing column fails LOUD with the migrate hint instead of
 * silently returning searcher-less rows that look complete.
 */
export const getSearchRecords = async (): Promise<SearchRecord[]> => {
  const db = await getClient();

  // The five reads run inside ONE db.batch(), which @libsql/client wraps in a
  // single (deferred) transaction: all child tables are read from the same
  // snapshot as the searches table, so a record can't come back with a child
  // list that was written a moment later by a concurrent recordSearch.
  const [searches, friends, games, locations, cheaters] = await withSchemaHint(
    db.batch([
      {
        sql: `
          SELECT s.id, s.searched_at, s.searcher_steam_id,
                  p.steam_id, p.steam_url, p.nickname, p.gc_name,
                  p.country_code, p.state_code, p.city_id,
                  p.is_cs_active, p.duration_ms,
                   m.requester_locale, m.requester_country,
                   m.requester_browser_language, m.device,
                   m.friends_visibility
           FROM searches s
           LEFT JOIN profiles p ON p.search_id = s.id
           LEFT JOIN search_meta m ON m.search_id = s.id
           ORDER BY s.searched_at ASC, s.id ASC
        `,
      },
      { sql: 'SELECT * FROM friends ORDER BY search_id, id' },
      { sql: 'SELECT * FROM games_snapshot ORDER BY search_id, id' },
      { sql: 'SELECT * FROM location_guesses ORDER BY search_id, id' },
      { sql: 'SELECT * FROM cheater_results' },
    ]),
  );

  const children = indexSearchChildren(
    friends.rows as Row[],
    locations.rows as Row[],
    cheaters.rows as Row[],
    games.rows as Row[],
  );

  return (searches.rows as Row[])
    .map((row) => mapSearchRecord(row, children))
    .filter((record) => record !== null);
};

// ---------------------------------------------------------------------------
// Dashboard fast path — aggregates + capped history.
//
// getSearchRecords() above ships FIVE full tables (friends/games/locations
// grow ~15/40/1 rows per search — 360k+ child rows today) for a page whose
// panels only ever render counts, top-N lists and a few hundred cheater
// rows. getDashboardStats() replaces that with small GROUP BY reads (one
// batch = one snapshot, same rationale as getSearchRecords), and
// getDashboardHistory() caps the row-level history table — the only panel
// rendering individual rows — WITHOUT the games_snapshot leg (no panel
// reads per-row games). getSearchRecords stays untouched for its tested
// full-read contract.
//
// Time-series bucketing (per-day/per-hour/today/week) deliberately stays
// client-side: the dashboard is owner-only and buckets in browser-local
// time, and server-side UTC bucketing would shift day boundaries. The
// timestamps list (~25 bytes/row) is the only unbounded read here —
// revisit with server-side bucketing if searches ever approach ~100k.
// ---------------------------------------------------------------------------

/** History-table window: individual rows below this, aggregates above. */
export const DASHBOARD_HISTORY_LIMIT = 500;

/**
 * History-window ceiling (shared with the dashboard route's ?limit= so
 * the two can never drift: a raised cap here without the route chokes
 * nothing, a raised route cap without this silently clamps).
 *
 * Deliberately 1500, not higher: every history row ships its full
 * friends[] (~2-2.5KB/row compact with ~15 friends), so 5000 rows would
 * land around ~10-12MB — past the ~4.5MB serverless function response
 * ceiling (FUNCTION_PAYLOAD_TOO_LARGE instead of a wider window). 1500
 * rows sit around ~3MB worst case: inside the budget with headroom left
 * for the stats sidecar (timestamps + cheater rows). A true full export
 * belongs in a dedicated streaming endpoint, not in this HTML page.
 */
export const DASHBOARD_HISTORY_LIMIT_MAX = 1500;

// COUNT/SUM arrive as number over hrana but as bigint on the native
// transport (file: URLs — local dev/test). Same bigint branch as
// toNullableNumber above; without it every aggregate silently reads 0
// outside production.
const toDashboardCount = (value: unknown): number => {
  if (typeof value === 'bigint') return Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
};

/**
 * Read-only dashboard aggregates (all-time) + every searched_at for
 * client-side bucketing. One batch = one snapshot. Throws when any table
 * is missing — the dashboard route fail-opens the whole stats half to
 * null (withSchemaHint rewrites to the db:migrate hint).
 *
 * 5min cross-request memo + single-flight (same per-instance pattern as
 * getSteamIdentity's avatar cache and the rate limiter: NOT shared across
 * serverless instances — accepted, this page has one reader). Without it
 * every F5 during a slow window stacks another ~1M-row scan on Turso
 * (Promise.race frees the response, never the driver query), and every
 * load re-reads friends + games for byte-identical aggregates.
 * Failures are never cached — a down DB must retry on the next load, not
 * serve "unavailable" for a full TTL. The history half stays live (it IS
 * the primary content and is already row-capped); only these all-time
 * aggregates memoize, and the page's generatedAt exposes the staleness.
 *
 * TTL is 5min (not 60s): the stats batch is the heaviest read on Turso
 * (production timed out at 8s before indexes + single-scan rewrites), and
 * a short TTL re-ran it on every other load. Owner-only page — 5min
 * staleness is disclosed via generatedAt.
 */
const DASHBOARD_STATS_TTL_MS = 300_000;

/**
 * Driver-level backstop for the stats batch (test seam — the route test
 * pins the user-facing 25s budget separately). The route's withTimeout
 * only frees the response; it never settles the shared inflight promise,
 * so a driver that hung forever would pin dashboardStatsInflight and serve
 * null until the instance recycled. This ceiling guarantees the inflight
 * always settles (failures are never cached — the next load retries).
 * Deliberately above the route's 25s budget: the route fail-open must fire
 * first; this only bounds the hung-driver tail. Under maxDuration = 60 the
 * function may die first — then the recycle clears the memo anyway.
 *
 * Known narrow window (accepted): firing only frees our wait, it does not
 * cancel the driver query — the next load starts a second heavy batch
 * while the first may still run on Turso. In practice the window opens
 * past 55s and the function dies at 60s, so at most one extra batch is
 * ever stacked; without the backstop the instance served null forever.
 */
export const DASHBOARD_STATS_DRIVER_TIMEOUT_MS = 55_000;
let dashboardStatsCache: {
  stats: DashboardStats;
  expiresAt: number;
} | null = null;
let dashboardStatsInflight: Promise<DashboardStats> | null = null;

/** Test seam: the TTL cache outlives single calls by design. */
export const clearDashboardStatsCache = (): void => {
  dashboardStatsCache = null;
  dashboardStatsInflight = null;
};

const readDashboardStats = async (): Promise<DashboardStats> => {
  const db = await getClient();
  const [
    summaryRows,
    friendsAggRows,
    timestampRows,
    localeRows,
    browserRows,
    deviceRows,
    countryRows,
    cheaterRows,
    gameRows,
    gameTotalsRows,
    locationRows,
    topProfileRows,
    topFriendRows,
  ] = await withSchemaHint(
    db.batch([
      {
        // INNER JOIN profiles (not LEFT): a profile-less search is corrupt
        // input — getSearchRecords drops those rows, so the totals must
        // not count them either, or "total" and the history note diverge.
        sql: `SELECT COUNT(*) AS total,
              COUNT(DISTINCT p.steam_id) AS unique_profiles,
              SUM(CASE WHEN m.friends_visibility = 'private' THEN 1 ELSE 0 END) AS private_lists,
              SUM(CASE WHEN p.gc_name IS NOT NULL AND p.gc_name != '' THEN 1 ELSE 0 END) AS gc_matches,
              AVG(p.duration_ms) AS avg_duration_ms
            FROM searches s
            JOIN profiles p ON p.search_id = s.id
            LEFT JOIN search_meta m ON m.search_id = s.id`,
      },
      {
        // Dedicated friends-totals statement (same batch = same snapshot
        // as the summary above): one scan computing COUNT(*) +
        // COUNT(DISTINCT steam_id) over the profiled-friends population
        // (EXISTS, not a bare table scan, so orphans never mix in).
        // Served by idx_friends_steam_id.
        sql: `SELECT COUNT(*) AS total_friends,
                COUNT(DISTINCT steam_id) AS unique_friends
              FROM friends
              WHERE EXISTS (SELECT 1 FROM profiles p2 WHERE p2.search_id = friends.search_id)`,
      },
      // Driven by profiled searches (same population as the summary
      // total, not raw searches): a profile-less orphan must not appear
      // in day/hour/donut buckets that "Recorded searches" excludes.
      { sql: `SELECT s.searched_at AS searched_at
              FROM searches s JOIN profiles p ON p.search_id = s.id
                AND p.steam_id IS NOT NULL AND p.steam_id != ''
              ORDER BY s.searched_at ASC` },
      // Capped at 200 buckets per map (display needs top 8 at most and
      // keys are partly client-influenced — browser language is free-form
      // — so the tail can never render and never travels). Same profiled
      // population as above; ties broken by key for stable repeats.
      {
        sql: `SELECT COALESCE(NULLIF(LOWER(m.requester_locale), ''), 'unknown') AS k,
                COUNT(*) AS n
              FROM searches s
              JOIN profiles p ON p.search_id = s.id
                AND p.steam_id IS NOT NULL AND p.steam_id != ''
              LEFT JOIN search_meta m ON m.search_id = s.id
              GROUP BY k ORDER BY n DESC, k ASC LIMIT 200`,
      },
      {
        sql: `SELECT COALESCE(NULLIF(LOWER(m.requester_browser_language), ''), 'unknown') AS k,
                COUNT(*) AS n
              FROM searches s
              JOIN profiles p ON p.search_id = s.id
                AND p.steam_id IS NOT NULL AND p.steam_id != ''
              LEFT JOIN search_meta m ON m.search_id = s.id
              GROUP BY k ORDER BY n DESC, k ASC LIMIT 200`,
      },
      {
        // Mirrors getSearchRecords' device coercion (mobile/desktop or
        // null → 'unknown'): anything else reads as unknown there too.
        sql: `SELECT CASE WHEN m.device IN ('mobile', 'desktop') THEN m.device ELSE 'unknown' END AS k,
                COUNT(*) AS n
              FROM searches s
              JOIN profiles p ON p.search_id = s.id
                AND p.steam_id IS NOT NULL AND p.steam_id != ''
              LEFT JOIN search_meta m ON m.search_id = s.id
              GROUP BY k ORDER BY n DESC, k ASC LIMIT 200`,
      },
      {
        // Mirrors normalizeCountryCode (2 ASCII letters → UPPER, else
        // null → 'unknown'): same buckets the client-side code produces.
        sql: `SELECT COALESCE(
                  CASE WHEN m.requester_country GLOB '[A-Za-z][A-Za-z]'
                    THEN UPPER(m.requester_country) ELSE NULL END,
                  'unknown') AS k,
                COUNT(*) AS n
              FROM searches s
              JOIN profiles p ON p.search_id = s.id
                AND p.steam_id IS NOT NULL AND p.steam_id != ''
              LEFT JOIN search_meta m ON m.search_id = s.id
              GROUP BY k ORDER BY n DESC, k ASC LIMIT 200`,
      },
      {
        // INNER JOIN profiles: a profile-less search renders a blank table
        // row, so getSearchRecords drops those records — the cheater rows
        // must drop them too instead of shipping steamId: null.
        sql: `SELECT s.searched_at AS searched_at, p.steam_id AS steam_id,
              p.nickname AS nickname, p.gc_name AS gc_name,
              p.country_code AS country_code, p.steam_url AS steam_url,
              (SELECT COUNT(*) FROM friends f WHERE f.search_id = s.id) AS friend_count,
              c.score AS score, c.banned_friends_count AS banned,
              c.computed_at AS computed_at
            FROM cheater_results c
            JOIN searches s ON s.id = c.search_id
            JOIN profiles p ON p.search_id = s.id
            ORDER BY s.searched_at ASC, s.id ASC`,
      },
      {
        // Single GROUP BY scan serving BOTH game charts (previously two
        // full scans of games_snapshot differing only in ORDER BY). The
        // CTE aggregates once per name; ROW_NUMBER ranks by volume and by
        // engagement with the same tiebreaks the two old queries used
        // (total_hours DESC, name ASC / engagement DESC, name ASC), and the
        // outer filter keeps the union of both top-20s (up to 40 rows) so
        // the client re-sort + slice stays exact (the client sorts both
        // charts itself — see dashboardTemplate.ts topGamesPerProfile /
        // topGamesEngagement — so payload order is irrelevant, but name
        // order keeps repeated loads byte-stable per repo convention).
        // Orphan searches (no profiles row) contribute no games — the JOIN
        // is 1:1 (profiles.search_id is the PK, no fan-out), so SUM and
        // COUNT(DISTINCT) match the old IN-filtered aggregates exactly.
        // JOIN (not IN) on purpose: it lets the planner stream the
        // covering index idx_games_snapshot_name in name order with PK
        // probes into profiles, instead of probing games per profile and
        // sorting 250k rows into groups in a temp b-tree.
        sql: `WITH game_agg AS (
              SELECT g.name AS name, SUM(g.playtime_hours) AS total_hours,
                COUNT(DISTINCT g.search_id) AS profile_count
              FROM games_snapshot g JOIN profiles p ON p.search_id = g.search_id GROUP BY g.name
            )
            SELECT name, total_hours, profile_count FROM (
              SELECT name, total_hours, profile_count,
                ROW_NUMBER() OVER (ORDER BY total_hours DESC, name ASC) AS rn_vol,
                ROW_NUMBER() OVER (ORDER BY total_hours * 1.0 / profile_count DESC, name ASC) AS rn_eng
              FROM game_agg
            ) WHERE rn_vol <= 20 OR rn_eng <= 20 ORDER BY name ASC`,
      },
      {
        sql: `SELECT COUNT(*) AS total,
                SUM(CASE WHEN is_cs_active = 1 THEN 1 ELSE 0 END) AS cs
              FROM profiles`,
      },
      {
        // First guess per search ONLY (MIN(id) = locationGuess[0]): the old
        // code counted e.locationGuess[0], so counting every guess would
        // inflate the panel and mix 1st/2nd/3rd guesses under one label.
        // Raw location JSON strings (client parses + formats the top 10 —
        // same skip-corrupt-row behavior as parseLocationGuesses). Capped:
        // only the head can ever render. Location tiebreak keeps repeats
        // stable; orphans excluded like every other population here.
        sql: `SELECT location, COUNT(*) AS n FROM location_guesses
              WHERE id IN (SELECT MIN(id) FROM location_guesses GROUP BY search_id)
                AND search_id IN (SELECT search_id FROM profiles)
              GROUP BY location ORDER BY n DESC, location ASC LIMIT 200`,
      },
      {
        // Latest meta row per Steam ID wins (entries were ASC with last-wins
        // overwrite). Single pass: SQLite resolves bare columns from the
        // MAX() row by documented guarantee, so nickname/gcName/countryCode
        // come from the most recent search without a self-join or a full
        // window-function sort. Ties on the max clock are arbitrary among
        // the tied rows (same as the old code's unknowable tie order).
        // steam_id ASC tiebreak keeps repeated loads stable.
        sql: `SELECT steam_id, nickname, gc_name, country_code, n FROM (
                SELECT p.steam_id AS steam_id, p.nickname AS nickname,
                  p.gc_name AS gc_name, p.country_code AS country_code,
                  COUNT(*) AS n, MAX(s.searched_at) AS last_seen
                FROM profiles p JOIN searches s ON s.id = p.search_id
                WHERE p.steam_id IS NOT NULL AND p.steam_id != ''
                GROUP BY p.steam_id
              ) ORDER BY n DESC, steam_id ASC LIMIT 8`,
      },
      {
        sql: `SELECT steam_id, nickname, gc_name, country_code, n FROM (
                SELECT f.steam_id AS steam_id, f.nickname AS nickname,
                  f.gc_name AS gc_name, f.country_code AS country_code,
                  COUNT(*) AS n, MAX(f.id) AS last_id
                FROM friends f
                WHERE f.steam_id IS NOT NULL AND f.steam_id != ''
                  AND EXISTS (SELECT 1 FROM profiles p WHERE p.search_id = f.search_id)
                GROUP BY f.steam_id
              ) ORDER BY n DESC, steam_id ASC LIMIT 8`,
      },
    ]),
  );

  const toCountMap = (result: { rows: unknown[] }): Record<string, number> => {
    const map: Record<string, number> = {};
    (result.rows as Array<Record<string, unknown>>).forEach((row) => {
      if (typeof row.k === 'string') map[row.k] = toDashboardCount(row.n);
    });
    return map;
  };

  // Single-scan union of the volume + engagement top-20s (see the
  // game_agg CTE above): every game either chart can render is present,
  // so the client-side re-sort + slice stays exact while the payload caps
  // at 40. Deduped by name defensively (the CTE already yields one row
  // per name — GROUP BY — so this is belt-and-braces, not load-bearing).
  const mapGameRows = (
    rows: Array<Record<string, unknown>>,
  ): DashboardGameRow[] => {
    const byName = new Map<string, DashboardGameRow>();
    rows.forEach((row) => {
      if (typeof row.name !== 'string' || byName.has(row.name)) return;
      byName.set(row.name, {
        name: row.name,
        totalHours: toDashboardCount(row.total_hours),
        profilesCount: toDashboardCount(row.profile_count),
      });
    });
    return Array.from(byName.values());
  };

  const summary = summaryRows.rows[0] as Record<string, unknown>;
  const totalSearches = toDashboardCount(summary.total);
  const friendsAgg =
    (friendsAggRows.rows[0] as Record<string, unknown> | undefined) ?? {};
  const gameTotals = gameTotalsRows.rows[0] as Record<string, unknown>;

  const toTopEntry = (row: Record<string, unknown>): DashboardTopEntry => ({
    steamId: row.steam_id as string,
    nickname: toNullableString(row.nickname),
    gcName: toNullableString(row.gc_name),
    countryCode: toNullableString(row.country_code),
    count: toDashboardCount(row.n),
  });

  const cheaterRowsOut: DashboardCheaterRow[] = (
    cheaterRows.rows as Array<Record<string, unknown>>
  ).map((row) => ({
    searchedAt: row.searched_at as string,
    steamId: row.steam_id as string,
    nickname: toNullableString(row.nickname),
    gcName: toNullableString(row.gc_name),
    countryCode: toNullableString(row.country_code),
    steamUrl: toNullableString(row.steam_url),
    friendCount: toDashboardCount(row.friend_count),
    score: toDashboardCount(row.score),
    bannedFriendsCount: toNullableNumber(row.banned),
    computedAt: row.computed_at as string,
  }));

  // avgDurationMs: SQL AVG skips NULLs exactly like the client's
  // typeof-number filter; a non-numeric value can't occur (REAL column).
  const avgDurationRaw = summary.avg_duration_ms;
  return {
    summary: {
      totalSearches,
      uniqueProfiles: toDashboardCount(summary.unique_profiles),
      uniqueFriends: toDashboardCount(friendsAgg.unique_friends),
      totalFriends: toDashboardCount(friendsAgg.total_friends),
      privateListSearches: toDashboardCount(summary.private_lists),
      gcMatches: toDashboardCount(summary.gc_matches),
      avgDurationMs:
        typeof avgDurationRaw === 'number' && Number.isFinite(avgDurationRaw)
          ? avgDurationRaw
          : null,
    },
    searchTimestamps: (timestampRows.rows as Array<Record<string, unknown>>)
      .map((row) => row.searched_at)
      .filter((v): v is string => typeof v === 'string'),
    localeCounts: toCountMap(localeRows),
    browserLangCounts: toCountMap(browserRows),
    deviceCounts: toCountMap(deviceRows),
    countryCounts: toCountMap(countryRows),
    cheaterRows: cheaterRowsOut,
    games: mapGameRows(gameRows.rows as Array<Record<string, unknown>>),
    totalProfilesForGames: toDashboardCount(gameTotals.total),
    csActiveCount: toDashboardCount(gameTotals.cs),
    locations: (locationRows.rows as Array<Record<string, unknown>>).map(
      (row): DashboardLocationRow => ({
        location: row.location as string,
        count: toDashboardCount(row.n),
      }),
    ),
    topProfiles: (topProfileRows.rows as Array<Record<string, unknown>>).map(
      toTopEntry,
    ),
    topFriends: (topFriendRows.rows as Array<Record<string, unknown>>).map(
      toTopEntry,
    ),
    generatedAt: new Date().toISOString(),
  };
};

export const getDashboardStats = async (): Promise<DashboardStats> => {
  if (
    dashboardStatsCache !== null &&
    dashboardStatsCache.expiresAt > Date.now()
  ) {
    return dashboardStatsCache.stats;
  }
  if (dashboardStatsInflight === null) {
    dashboardStatsInflight = withTimeout(
      readDashboardStats(),
      'dashboard stats',
      DASHBOARD_STATS_DRIVER_TIMEOUT_MS,
    ).finally(() => {
      dashboardStatsInflight = null;
    });
  }
  const stats = await dashboardStatsInflight;
  dashboardStatsCache = {
    stats,
    expiresAt: Date.now() + DASHBOARD_STATS_TTL_MS,
  };
  return stats;
};

/**
 * Read-only capped history for the dashboard's search-history table (the
 * only panel rendering individual rows). Same record shape as
 * getSearchRecords but newest-first, capped, and WITHOUT the
 * games_snapshot leg (no history panel reads per-row games). The export
 * CSV and the text filter operate on this same window — the panel says
 * so explicitly ("showing last N of M").
 */
export const getDashboardHistory = async (
  limit: number = DASHBOARD_HISTORY_LIMIT,
): Promise<SearchRecord[]> => {
  // Validated BEFORE getClient(): a bad limit must fail without opening
  // (or reusing) a pooled connection for nothing.
  if (!Number.isFinite(limit)) {
    throw new Error('Invalid history limit: expected a finite number');
  }
  const n = Math.max(
    1,
    Math.min(DASHBOARD_HISTORY_LIMIT_MAX, Math.floor(limit)),
  );
  const db = await getClient();

  const [searches, friends, locations, cheaters] = await withSchemaHint(
    db.batch([
      {
        // INNER JOIN profiles (same orphan rule as mapSearchRecord, which
        // drops null/empty steam_ids): a LEFT JOIN would let orphans eat
        // window slots and return fewer than N rows for a "last N of M"
        // note computed over profiled searches.
        sql: `
          SELECT s.id, s.searched_at,
                 p.steam_id, p.steam_url, p.nickname, p.gc_name,
                 p.country_code, p.state_code, p.city_id,
                 p.is_cs_active, p.duration_ms,
                  m.requester_locale, m.requester_country,
                  m.requester_browser_language, m.device,
                  m.friends_visibility
           FROM searches s
           JOIN profiles p ON p.search_id = s.id
             AND p.steam_id IS NOT NULL AND p.steam_id != ''
           LEFT JOIN search_meta m ON m.search_id = s.id
           ORDER BY s.searched_at DESC, s.id DESC
           LIMIT ?`,
        args: [n],
      },
      {
        // Same profiled window as the main query: orphan children have no
        // parent record (mapSearchRecord drops them) so fetching them only
        // burns rows-read.
        sql: `SELECT * FROM friends WHERE search_id IN (
                SELECT s.id FROM searches s
                JOIN profiles p ON p.search_id = s.id
                  AND p.steam_id IS NOT NULL AND p.steam_id != ''
                ORDER BY s.searched_at DESC, s.id DESC LIMIT ?
              ) ORDER BY search_id, id`,
        args: [n],
      },
      {
        sql: `SELECT * FROM location_guesses WHERE search_id IN (
                SELECT s.id FROM searches s
                JOIN profiles p ON p.search_id = s.id
                  AND p.steam_id IS NOT NULL AND p.steam_id != ''
                ORDER BY s.searched_at DESC, s.id DESC LIMIT ?
              ) ORDER BY search_id, id`,
        args: [n],
      },
      {
        sql: `SELECT * FROM cheater_results WHERE search_id IN (
                SELECT s.id FROM searches s
                JOIN profiles p ON p.search_id = s.id
                  AND p.steam_id IS NOT NULL AND p.steam_id != ''
                ORDER BY s.searched_at DESC, s.id DESC LIMIT ?
              )`,
        args: [n],
      },
    ]),
  );

  const children = indexSearchChildren(
    friends.rows as Row[],
    locations.rows as Row[],
    cheaters.rows as Row[],
    null,
  );

  return (searches.rows as Row[])
    .map((row) => mapSearchRecord(row, children))
    .filter((record) => record !== null);
};

// ---------------------------------------------------------------------------
// Programmatic player sitemap (P0 SEO) — demand-ordered profile aggregates.
//
// The sitemap indexer feeds on finished searches (real demand), not on a
// static list: profiles graduate into the sitemap once minSearches distinct
// searches exist, most-searched first. Rows with malformed steam_ids are
// skipped (a sitemap URL must resolve — one legacy row must not nuke the
// shard), and the nickname is observability only (the page title resolves
// live from Steam at render time). No cheater data travels here by
// construction: the SELECT touches only profiles + searches.
//
// Documented debt (same pattern as getLoginFunnelStats): no time window —
// the aggregation scans the full searches history on every daily build.
// At current volume that scan is seconds; revisit with a rolling window
// (e.g. trailing 12 months) if the table ever slows the build past budget.
// ---------------------------------------------------------------------------

/**
 * Independent safety ceiling for one DAL read (not the product cap):
 * SITEMAP_MAX_URLS (lib/seo/playerSitemap.ts) is what the sitemap passes
 * as limit and must stay <= this — anything above is silently clamped.
 */
const POPULAR_PROFILES_MAX_LIMIT = 10000;

const toPopularProfile = (row: Record<string, unknown>): PopularProfile | null => {
  const steamId = row.steam_id;
  const lastSearchedAt = row.last_searched_at;
  // Fail-closed per row (mirrors the inbox parsers): malformed steam_ids
  // (legacy vanity/unresolved rows) cannot form a /player/ URL, so they
  // fall out instead of poisoning the shard.
  if (typeof steamId !== 'string' || !isSteamId64(steamId)) return null;
  if (typeof lastSearchedAt !== 'string' || lastSearchedAt.length === 0) {
    return null;
  }
  // COUNT(*) arrives as number over hrana JSON, but the native file:
  // transport can hand back bigint — same defensive read as
  // toNullableNumber/getLoginFunnelStats (counts here are small, but the
  // mapper must not NaN on either shape).
  let searchCount = 0;
  if (
    typeof row.search_count === 'number' &&
    Number.isFinite(row.search_count)
  ) {
    searchCount = Math.floor(row.search_count);
  } else if (typeof row.search_count === 'bigint') {
    searchCount = Number(row.search_count);
  }
  return {
    steamId,
    nickname: typeof row.nickname === 'string' ? row.nickname : null,
    lastSearchedAt,
    searchCount,
  };
};

/**
 * Demand-ordered profile page (one sitemap read): most-searched first,
 * newest search breaks ties. limit is clamped to 1..10000 (the sitemap
 * crawl-budget cap), offset floored at 0, minSearches and minDays floored
 * at 1. Non-finite inputs throw.
 *
 * Anti-abuse gate (harassment-by-indexing): a profile graduates only with
 * minSearches searches SPREAD OVER minDays distinct UTC days — three
 * back-to-back lookups cannot force a stranger into the public sitemap
 * (and from there into Google). A determined actor returning across days
 * still can; full protection would need per-visitor identity signals the
 * product deliberately never collects (no IP/session tracking), so this
 * raises the cost from seconds to deliberate multi-day effort instead.
 *
 * Nickname is the LATEST recorded one per profile (correlated subquery on
 * max searched_at — one indexed lookup per qualifying group, trivial at
 * current volume), not MAX() (which would return the lexicographic max).
 * Malformed steam_ids are excluded in SQL (exactly-17-digits guard) with
 * the row-mapper skip below as backstop.
 */
export const listPopularProfiles = async (
  limit = POPULAR_PROFILES_MAX_LIMIT,
  offset = 0,
  minSearches = 3,
  minDays = 2,
): Promise<PopularProfile[]> => {
  if (
    !Number.isFinite(limit) ||
    !Number.isFinite(offset) ||
    !Number.isFinite(minSearches) ||
    !Number.isFinite(minDays)
  ) {
    throw new Error(
      'Invalid pagination for popular profiles: expected finite numbers',
    );
  }
  const n = Math.max(1, Math.min(POPULAR_PROFILES_MAX_LIMIT, Math.floor(limit)));
  const start = Math.max(0, Math.floor(offset));
  const threshold = Math.max(1, Math.floor(minSearches));
  const days = Math.max(1, Math.floor(minDays));
  const db = await getClient();
  const rows = await withSchemaHint(
    db.execute({
      sql: `SELECT p.steam_id AS steam_id,
                   (SELECT p2.nickname
                    FROM profiles p2
                    JOIN searches s2 ON s2.id = p2.search_id
                    WHERE p2.steam_id = p.steam_id
                    ORDER BY s2.searched_at DESC
                    LIMIT 1) AS nickname,
                   MAX(s.searched_at) AS last_searched_at,
                   COUNT(*) AS search_count
            FROM profiles p
            JOIN searches s ON s.id = p.search_id
            WHERE length(p.steam_id) = 17 AND p.steam_id NOT GLOB '*[^0-9]*'
            GROUP BY p.steam_id
            HAVING COUNT(*) >= ? AND COUNT(DISTINCT date(s.searched_at)) >= ?
            ORDER BY search_count DESC, last_searched_at DESC
            LIMIT ? OFFSET ?`,
      args: [threshold, days, n, start],
    }),
  );
  const out: PopularProfile[] = [];
  // eslint-disable-next-line no-restricted-syntax
  for (const row of rows.rows) {
    const profile = toPopularProfile(row as Record<string, unknown>);
    if (profile !== null) out.push(profile);
  }
  return out;
};
