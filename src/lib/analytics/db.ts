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
    if (error instanceof Error && SCHEMA_MISSING_TABLE_PATTERN.test(error.message)) {
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
        location: JSON.parse(row.location as string) as LocationGuess['location'],
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
      playtimeHours: typeof row.playtime_hours === 'number' ? row.playtime_hours : Number(row.playtime_hours ?? 0),
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
      isCSActive: typeof isActive === 'number' && (isActive === 0 || isActive === 1)
        ? isActive === 1
        : null,
      requesterLocale: toNullableString(row.requester_locale),
      requesterCountry: toNullableString(row.requester_country),
      requesterBrowserLanguage: toNullableString(row.requester_browser_language),
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
