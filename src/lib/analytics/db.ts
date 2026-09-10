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
  WatchStatus,
  WatchEventKind,
  WatchedProfile,
  WatchEvent,
} from './types';
import { toSqlBool, nullableText } from './sqlHelpers';
import { requireRemoteTursoToken } from '../env';
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

const SCHEMA_MISSING_TABLE_PATTERN = /no such table/i;

// A client that was created fine can still die later (idle timeout, network
// blip, Turso closing a hrana session). These are the error shapes the driver
// produces when that happens; anything matching invalidates the memoized
// client so the next call rebuilds it instead of serving 500s from a dead
// connection until the container recycles.
const CONNECTION_FAILURE_PATTERN =
  /(?:connection|socket|session is closed|ECONNRESET|ECONNREFUSED|network|fetch failed|timeout|timed out)/i;

// Classifies an error as a transport/connectivity failure (as opposed to a
// query/logic error). Exported so the smoke scripts (db-smoke, smoke-analytics)
// can distinguish "Turso is unreachable right now" — an environment problem
// that a pre-push hook should SKIP, not fail the push over — from a genuine
// analytics regression, which must still FAIL.
export const isTransportFailure = (error: unknown): boolean =>
  error instanceof Error && CONNECTION_FAILURE_PATTERN.test(error.message);

const withSchemaHint = async <T>(operation: Promise<T>): Promise<T> => {
  try {
    return await operation;
  } catch (error) {
    if (
      error instanceof Error &&
      SCHEMA_MISSING_TABLE_PATTERN.test(error.message)
    ) {
      throw new Error(
        'Analytics database schema is missing — run `pnpm run db:migrate` first.',
      );
    }
    // If a transport failure is caught here, the memoized client is stale —
    // null it so the next call reconnects. All operations on the memo share
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

  const record: SearchRecord = {
    id,
    searchedAt,
    cheater: null,
    ...input,
  };

  const statements: Array<{ sql: string; args: (string | number | null)[] }> = [
    // 1. Root entity
    {
      sql: 'INSERT INTO searches (id, searched_at) VALUES (?, ?)',
      args: [id, searchedAt],
    },
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
    // 3. Search meta (1:1)
    {
      sql: `INSERT INTO search_meta
            (search_id, requester_locale, requester_country,
             requester_browser_language, device)
            VALUES (?, ?, ?, ?, ?)`,
      args: [
        id,
        record.requesterLocale ?? null,
        record.requesterCountry ?? null,
        record.requesterBrowserLanguage ?? null,
        record.device ?? null,
      ],
    },
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

  await withSchemaHint(db.batch(statements));

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
      /^\d{17}$/.test(entry.steamId) &&
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
// - Epic 5/6 (inbox + opt-out): watch_events rows ARE the inbox source;
//   deactivateWatch is the opt-out.
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

const STEAM_ID64_RE = /^\d{17}$/;

const assertSteamId64 = (steamId: string): void => {
  if (typeof steamId !== 'string' || !STEAM_ID64_RE.test(steamId)) {
    throw new Error('Invalid SteamID64 for watch DAL: expected 17 digits');
  }
};

const assertWatchEventKind: (kind: string) => asserts kind is WatchEventKind = (
  kind,
) => {
  if (kind !== 'invite' && kind !== 'notify') {
    throw new Error("Invalid watch event kind: expected 'invite' | 'notify'");
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

const toWatchEvent = (row: Record<string, unknown>): WatchEvent => ({
  id: Number(row.id),
  searchId: typeof row.search_id === 'string' ? row.search_id : null,
  steamId: row.steam_id as string,
  kind: row.kind === 'notify' ? 'notify' : 'invite',
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
 * Transitions pending -> active (+activated_at). Idempotent: an already
 * active watch returns true; a missing row returns false (nothing to
 * activate — Epic 3 treats that as "unknown profile").
 */
export const activateWatch = async (steamId: string): Promise<boolean> => {
  assertSteamId64(steamId);
  const db = await getClient();

  const updated = await withSchemaHint(
    db.execute({
      sql: `UPDATE watched_profiles
            SET status = 'active', activated_at = ?
            WHERE steam_id = ? AND status = 'pending'`,
      args: [new Date().toISOString(), steamId],
    }),
  );
  if (Number(updated.rowsAffected) > 0) return true;

  return (await getWatchStatus(steamId)) === 'active';
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
 * getWatchStatus + isWithinCooldown before enqueueing.
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
 * notifications forever.
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
  if (typeof last !== 'string') return false;
  const lastMs = Date.parse(last);
  if (!Number.isFinite(lastMs)) return false;
  return Date.now() - lastMs < windowHours * 3600000;
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

/**
 * How many invite events were SENT at or after `sinceIso` (an ISO-8601
 * timestamp — lexicographic comparison works because every sent_at is
 * written in the same UTC ISO format). Feeds the bot's daily send cap
 * (P1-1): the count lives in the database, not in poller memory, so it
 * survives bot restarts and is exact rather than "since this boot".
 */
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
          SELECT s.id, s.searched_at,
                 p.steam_id, p.steam_url, p.nickname, p.gc_name,
                 p.country_code, p.state_code, p.city_id,
                 p.is_cs_active, p.duration_ms,
                 m.requester_locale, m.requester_country,
                 m.requester_browser_language, m.device
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

  const friendsBySearch = new Map<string, FriendRecord[]>();
  friends.rows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = friendsBySearch.get(searchId) ?? [];
    list.push({
      steamId: row.steam_id as string,
      nickname: toNullableString(row.nickname),
      gcName: toNullableString(row.gc_name),
      mutualCount: toNullableNumber(row.mutual_count),
      probability: toNullableNumber(row.probability),
      countryCode: toNullableString(row.country_code),
    });
    friendsBySearch.set(searchId, list);
  });

  const gamesBySearch = new Map<string, GameSnapshotEntry[]>();
  games.rows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = gamesBySearch.get(searchId) ?? [];
    list.push({
      name: row.name as string,
      playtimeHours:
        typeof row.playtime_hours === 'number'
          ? row.playtime_hours
          : Number(row.playtime_hours ?? 0),
    });
    gamesBySearch.set(searchId, list);
  });

  const locationsBySearch = new Map<string, LocationGuess[]>();
  locations.rows.forEach((row) => {
    const searchId = row.search_id as string;
    const list = locationsBySearch.get(searchId) ?? [];
    list.push(...parseLocationGuesses([row]));
    locationsBySearch.set(searchId, list);
  });

  const cheatersBySearch = new Map<string, CheaterProbabilityRecord>();
  cheaters.rows.forEach((row) => {
    cheatersBySearch.set(row.search_id as string, {
      score: row.score as number,
      bannedFriendsCount: toNullableNumber(row.banned_friends_count),
      computedAt: row.computed_at as string,
    });
  });

  return searches.rows
    .map((row) => {
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
      const cheater = cheatersBySearch.get(searchId) ?? null;

      return {
        id: searchId,
        searchedAt: row.searched_at as string,
        profile,
        // An empty child table reads back as arrays/nulls regardless of whether
        // the source sent `[]` or `undefined` (both store zero rows) — fine, the
        // dashboard treats null and [] the same (it maps over `?? []`).
        friends: friendsBySearch.get(searchId) ?? [],
        gamesSnapshot: gamesBySearch.get(searchId) ?? null,
        isCSActive:
          typeof isActive === 'number' && (isActive === 0 || isActive === 1)
            ? isActive === 1
            : null,
        requesterLocale: toNullableString(row.requester_locale),
        requesterCountry: toNullableString(row.requester_country),
        requesterBrowserLanguage: toNullableString(
          row.requester_browser_language,
        ),
        device: (device === 'mobile' || device === 'desktop'
          ? device
          : null) as 'mobile' | 'desktop' | null,
        locationGuess: locationsBySearch.get(searchId) ?? null,
        cheater,
        durationMs: toNullableNumber(row.duration_ms),
      };
    })
    .filter((record) => record !== null);
};
