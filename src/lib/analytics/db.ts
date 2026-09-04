/**
 * Analytics DAL — Turso (libSQL) backend.
 *
 * Drop-in replacement for the JSON-file based recordSearch() and
 * attachCheaterProbability() in proxy-local/utils/analytics.ts.
 * Exported from src/lib/ so it can eventually be consumed by Vercel
 * serverless routes too (not just the proxy).
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
  GameSnapshotEntry,
  LocationGuess,
} from '../../proxy-local/utils/analytics';
import { toSqlBool, nullableText } from './sqlHelpers';

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

  if (url.startsWith('libsql://') && !process.env.DATABASE_TOKEN) {
    throw new Error(
      'DATABASE_TOKEN is required for remote Turso URLs (libsql://). Set it in .env.',
    );
  }

  const c = createClient({
    url,
    authToken: process.env.DATABASE_TOKEN || undefined,
  });

  // SQLite disables FK enforcement by default; set it per-connection.
  // For HTTP transport (Turso remoto), this applies to subsequent statements
  // on this client instance.
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
// recordSearch — insert a completed search across all normalized tables.
// Uses db.batch() so the entire insert is atomic (BEGIN/COMMIT/ROLLBACK).
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

  // 4. Friends (N:1)
  record.friends.forEach((f) => {
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
  (record.gamesSnapshot ?? []).forEach((g) => {
    statements.push({
      sql: 'INSERT INTO games_snapshot (search_id, name, playtime_hours) VALUES (?, ?, ?)',
      args: [id, g.name, g.playtimeHours],
    });
  });

  // 6. Location guesses (N:1) — location is a JSON-serialized object
  (record.locationGuess ?? []).forEach((lg) => {
    statements.push({
      sql: 'INSERT INTO location_guesses (search_id, location, probability) VALUES (?, ?, ?)',
      args: [id, JSON.stringify(lg.location), lg.probability],
    });
  });

  await db.batch(statements);

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

  // Explicit check — deterministic, no reliance on FK error message text.
  const exists = await db.execute({
    sql: 'SELECT 1 FROM searches WHERE id = ?',
    args: [searchId],
  });

  if (exists.rows.length === 0) return false;

  await db.execute({
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
  });

  return true;
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

const parseLocationGuesses = (rows: Row[]): LocationGuess[] =>
  rows.map((row) => ({
    location: JSON.parse(row.location as string) as LocationGuess['location'],
    probability: typeof row.probability === 'number' ? row.probability : 0,
  }));

export const getSearchRecords = async (): Promise<SearchRecord[]> => {
  const db = await getClient();

  const [searches, friends, games, locations, cheaters] = await Promise.all([
    db.execute(`
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
    `),
    db.execute('SELECT * FROM friends ORDER BY search_id, id'),
    db.execute('SELECT * FROM games_snapshot ORDER BY search_id, id'),
    db.execute('SELECT * FROM location_guesses ORDER BY search_id, id'),
    db.execute('SELECT * FROM cheater_results'),
  ]);

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

  return searches.rows.map((row) => {
    const searchId = row.id as string;

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
      friends: friendsBySearch.get(searchId) ?? [],
      gamesSnapshot: gamesBySearch.get(searchId) ?? null,
      isCSActive: typeof isActive === 'number' && (isActive === 0 || isActive === 1)
        ? isActive === 1
        : null,
      requesterLocale: toNullableString(row.requester_locale),
      requesterCountry: toNullableString(row.requester_country),
      requesterBrowserLanguage: toNullableString(row.requester_browser_language),
      device: device === 'mobile' || device === 'desktop' ? device : null,
      locationGuess: locationsBySearch.get(searchId) ?? null,
      cheater,
      durationMs: toNullableNumber(row.duration_ms),
    };
  });
};
