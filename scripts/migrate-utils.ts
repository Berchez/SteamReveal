import type { SearchRecord } from '../src/lib/analytics/types';
import { toSqlBool, nullableText } from '../src/lib/analytics/sqlHelpers';
import {
  filterValidFriends,
  filterValidGames,
  filterValidLocations,
} from '../src/lib/analytics/normalize';

export type Statement = { sql: string; args: (string | number | null)[] };

/**
 * Builds the full statement set (parent + children + meta + cheater) for one
 * historical record. Kept in its own module so the column/arg pairing — the
 * classic silent bug class in an import like this — is directly unit-testable.
 *
 * Child tables use DELETE-then-INSERT so re-running the migration after a
 * partial failure never duplicates rows. `friends`/`gamesSnapshot`/etc. are
 * normalized with `?? []` so a legacy record missing a field degrades to
 * "no children" instead of throwing for the whole record.
 *
 * Parent tables (profiles, search_meta, cheater_results) use UPSERT
 * (ON CONFLICT(search_id) DO UPDATE) so a re-run also reconciles them to the
 * source payload — otherwise a record whose parent rows were inserted on a
 * first (partial) run would keep stale values forever, since OR IGNORE only
 * inserts missing rows. Root `searches` is the exception: it owns the
 * immutable id/searchedAt identity, so it stays INSERT OR IGNORE (re-running
 * must never rewrite a search's creation time).
 *
 * Child entries are filtered through the SAME validators the live write route
 * uses (src/lib/analytics/normalize.ts). A single mangled child from an old
 * data file is dropped inline rather than fail the whole atomic batch (which
 * would roll back the record's other children too). The record's own id is
 * never hidden: the caller reports skipped record ids, and a skipped child is
 * cheap to re-import by hand.
 */
export function buildStatements(record: SearchRecord): Statement[] {
  const stmts: Statement[] = [];

  stmts.push({
    sql: 'INSERT OR IGNORE INTO searches (id, searched_at) VALUES (?, ?)',
    args: [record.id, record.searchedAt],
  });

  stmts.push({
    sql: `INSERT INTO profiles
          (search_id, steam_id, steam_url, nickname, gc_name,
           country_code, state_code, city_id, is_cs_active, duration_ms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(search_id) DO UPDATE SET
            steam_id = excluded.steam_id,
            steam_url = excluded.steam_url,
            nickname = excluded.nickname,
            gc_name = excluded.gc_name,
            country_code = excluded.country_code,
            state_code = excluded.state_code,
            city_id = excluded.city_id,
            is_cs_active = excluded.is_cs_active,
            duration_ms = excluded.duration_ms`,
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
    sql: `INSERT INTO search_meta
          (search_id, requester_locale, requester_country,
           requester_browser_language, device)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(search_id) DO UPDATE SET
            requester_locale = excluded.requester_locale,
            requester_country = excluded.requester_country,
            requester_browser_language = excluded.requester_browser_language,
            device = excluded.device`,
    args: [
      record.id,
      record.requesterLocale ?? null,
      record.requesterCountry ?? null,
      record.requesterBrowserLanguage ?? null,
      record.device ?? null,
    ],
  });

  stmts.push({
    sql: 'DELETE FROM friends WHERE search_id = ?',
    args: [record.id],
  });
  filterValidFriends(record.friends ?? []).forEach((f) => {
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
  filterValidGames(record.gamesSnapshot ?? []).forEach((g) => {
    stmts.push({
      sql: 'INSERT INTO games_snapshot (search_id, name, playtime_hours) VALUES (?, ?, ?)',
      args: [record.id, g.name, g.playtimeHours],
    });
  });

  stmts.push({
    sql: 'DELETE FROM location_guesses WHERE search_id = ?',
    args: [record.id],
  });
  filterValidLocations(record.locationGuess ?? []).forEach((lg) => {
    stmts.push({
      sql: 'INSERT INTO location_guesses (search_id, location, probability) VALUES (?, ?, ?)',
      args: [record.id, JSON.stringify(lg.location), lg.probability],
    });
  });

  if (record.cheater) {
    stmts.push({
      sql: `INSERT INTO cheater_results
            (search_id, score, banned_friends_count, computed_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(search_id) DO UPDATE SET
              score = excluded.score,
              banned_friends_count = excluded.banned_friends_count,
              computed_at = excluded.computed_at`,
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